import { exactKeys, integer, protocolError, record } from "./decode.js";
import {
  advanceFrameBridgeGeneration, clearFrameBridgeKick, FrameBridgeDoorbell, FrameRing,
  frameBridgeGeneration, frameRecordEnds, FRAME_BRIDGE_RING_BYTES, publishRouterCounters,
  publishRouterGeneration, readRouterCounters, routerGeneration, type FrameDirection,
} from "./frame-bridge.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";

type FrameQueue = Pick<FrameRing,"usedBytes"|"freeBytes"|"write"|"peek"|"advance"|"skipAll">;
type Port = {postMessage(message:unknown,transfer?:Transferable[]):void};
export interface FrameTransport {
  readonly toRouter: FrameQueue; readonly toLinux: FrameQueue;
  readonly generation: number; readonly routerGeneration: number;
  advanceGeneration(): void; publishGeneration(generation:number): void;
  publishCounters(bytes:Uint8Array): void; readCounters(): Uint8Array<ArrayBuffer>|undefined;
  clearKick(): void; ring(): boolean;
  /** True for a validated transport message; false for the existing ready/notice envelope. */
  receive(value:unknown): boolean;
}
export function createFrameTransport(bridge:SharedArrayBuffer|"message",port:Port,role:"control"|"router"):FrameTransport {
  if (bridge === "message") return new MessageFrameTransport(port,role);
  const doorbell=new FrameBridgeDoorbell(bridge,port);
  return {
    toRouter:new FrameRing(bridge,"to-router"),toLinux:new FrameRing(bridge,"to-linux"),
    get generation(){return frameBridgeGeneration(bridge);},get routerGeneration(){return routerGeneration(bridge);},
    advanceGeneration:()=>{advanceFrameBridgeGeneration(bridge);}, publishGeneration:generation=>{publishRouterGeneration(bridge,generation);},
    publishCounters:bytes=>{publishRouterCounters(bridge,bytes);},readCounters:()=>readRouterCounters(bridge),
    clearKick:()=>{clearFrameBridgeKick(bridge);},ring:()=>doorbell.ring(),receive:()=>false,
  };
}
const MAX_BATCH=256*1024;

class MessageFrameTransport implements FrameTransport {
  readonly toRouter: MessageFrameQueue; readonly toLinux: MessageFrameQueue;
  readonly #port:Port; readonly #role:"control"|"router";
  #generation=0;#routerGeneration=0;#counters:Uint8Array<ArrayBuffer>|undefined;
  #counterSequence=0;#receivedCounterSequence=0;
  constructor(port:Port,role:"control"|"router") {
    this.#port=port;this.#role=role;
    this.toRouter=new MessageFrameQueue("to-router",role==="control",(type,payload,transfer)=>this.#send(type,payload,transfer));
    this.toLinux=new MessageFrameQueue("to-linux",role==="router",(type,payload,transfer)=>this.#send(type,payload,transfer));
  }
  get generation():number{return this.#generation;}
  get routerGeneration():number{return this.#routerGeneration;}
  advanceGeneration():void {
    if(this.#role!=="control"||this.#generation===0x7fff_ffff)throw protocolError("Invalid frame reset owner or exhausted generation");
    this.#reset(this.#generation+1);this.#send("frame-reset",{});
  }
  publishGeneration(generation:number):void {
    if(this.#role!=="router"||generation!==this.#generation)throw protocolError("Invalid router generation publication");
    this.#routerGeneration=generation;this.#send("frame-generation",{});
  }
  publishCounters(bytes:Uint8Array):void {
    if(this.#role!=="router"||bytes.length===0||bytes.length>512)throw protocolError("Invalid router counters publication");
    const copy=bytes.slice();this.#send("frame-counters",{sequence:this.#counterSequence++,bytes:copy},[copy.buffer]);
  }
  readCounters():Uint8Array<ArrayBuffer>|undefined{return this.#counters?.slice();}
  clearKick():void{}
  ring():boolean {this.#port.postMessage({version:1,type:"frames",generation:this.#generation});return true;}
  #send(type:string,payload:Readonly<Record<string,unknown>>,transfer:Transferable[]=[]):void {
    this.#port.postMessage({version:PROTOCOL_VERSION,type,generation:this.#generation,...payload},transfer);
  }
  receive(value:unknown):boolean {
    const input=record(value,"frame transport message");
    if(typeof input["type"]!=="string"||!input["type"].startsWith("frame-"))return false;
    if(input["version"]!==PROTOCOL_VERSION)throw protocolError("Frame transport version mismatch");
    const generation=integer(input["generation"],"frame generation",0,0x7fff_ffff);
    switch(input["type"]) {
      case "frame-reset":
        exactKeys(input,["version","type","generation"]);
        if(this.#role!=="router"||generation!==this.#generation+1)throw protocolError("Invalid frame reset");
        this.#reset(generation);return true;
      case "frame-generation":
        exactKeys(input,["version","type","generation"]);
        if(this.#role!=="control"||generation>this.#generation)throw protocolError("Invalid router generation");
        if(generation===this.#generation)this.#routerGeneration=generation;return true;
      case "frame-counters": {
        exactKeys(input,["version","type","generation","sequence","bytes"]);
        const bytes=input["bytes"];const sequence=integer(input["sequence"],"counter sequence",0);
        if(this.#role!=="control"||!(bytes instanceof Uint8Array)||bytes.length===0||bytes.length>512||generation>this.#generation)throw protocolError("Invalid router counter message");
        if(generation<this.#generation)return true;
        if(sequence!==this.#receivedCounterSequence++)throw protocolError("Invalid router counter sequence");
        this.#counters=bytes.slice();return true;
      }
      case "frame-batch":case "frame-credit": {
        const credit=input["type"]==="frame-credit";
        exactKeys(input,["version","type","generation","sequence","direction",credit?"bytes":"records"]);
        const direction=input["direction"];
        if(direction!=="to-router"&&direction!=="to-linux")throw protocolError("Invalid frame direction");
        const queue=direction==="to-router"?this.toRouter:this.toLinux;
        const sequence=integer(input["sequence"],"frame sequence",0);
        if(credit) {
          const bytes=integer(input["bytes"],"consumed frame bytes",1,FRAME_BRIDGE_RING_BYTES);
          if(!queue.writer||generation>this.#generation)throw protocolError("Invalid frame credit owner");
          if(generation===this.#generation)queue.credit(sequence,bytes);
        } else {
          const records=input["records"];
          if(queue.writer||!(records instanceof Uint8Array)||records.length===0||records.length>MAX_BATCH||generation>this.#generation)throw protocolError("Invalid frame batch");
          const ends=frameRecordEnds(records);
          if(generation===this.#generation)queue.accept(sequence,records,ends);
        }
        return true;
      }
      default:throw protocolError("Unknown frame transport operation");
    }
  }
  #reset(generation:number):void {
    this.#generation=generation;this.toRouter.reset();this.toLinux.reset();this.#counters=undefined;
    this.#counterSequence=0;this.#receivedCounterSequence=0;
  }
}
class MessageFrameQueue implements FrameQueue {
  readonly writer:boolean;readonly #direction:FrameDirection;
  readonly #send:(type:string,payload:Readonly<Record<string,unknown>>,transfer?:Transferable[])=>void;
  #used=0;#sent=0;#credited=0;#sentEnds:number[]=[];#sentCursor=0;
  #sequence=0;#received=0;#creditSequence=0;#receivedCredit=0;
  readonly #chunks:Array<{bytes:Uint8Array;ends:readonly number[];offset:number}>=[];
  constructor(direction:FrameDirection,writer:boolean,send:(type:string,payload:Readonly<Record<string,unknown>>,transfer?:Transferable[])=>void){this.#direction=direction;this.writer=writer;this.#send=send;}
  usedBytes():number{return this.#used;}
  freeBytes():number{return FRAME_BRIDGE_RING_BYTES-this.#used;}
  write(records:Uint8Array):void {
    const ends=frameRecordEnds(records);
    if(!this.writer||records.length===0||records.length>MAX_BATCH||records.length>this.freeBytes())throw protocolError("Frame batch exceeds available credit");
    for(const end of ends)this.#sentEnds.push(this.#sent+end);
    this.#sent+=records.length;this.#used+=records.length;
    const copy=records.slice();this.#send("frame-batch",{direction:this.#direction,sequence:this.#sequence++,records:copy},[copy.buffer]);
  }
  accept(sequence:number,records:Uint8Array,ends:readonly number[]):void {
    if(this.writer||sequence!==this.#received++||records.length>this.freeBytes())throw protocolError("Frame sequence or receive credit exceeded");
    this.#chunks.push({bytes:records,ends,offset:0});this.#used+=records.length;
  }
  credit(sequence:number,bytes:number):void {
    const target=this.#credited+bytes;let cursor=this.#sentCursor;
    while(cursor<this.#sentEnds.length&&(this.#sentEnds[cursor]??Infinity)<target)cursor++;
    if(!this.writer||sequence!==this.#receivedCredit++||bytes>this.#used||this.#sentEnds[cursor]!==target)throw protocolError("Invalid frame consumption credit");
    this.#credited=target;this.#used-=bytes;this.#sentCursor=cursor+1;
    if(this.#sentCursor>4096){this.#sentEnds.splice(0,this.#sentCursor);this.#sentCursor=0;}
  }
  peek(destination:Uint8Array):ReturnType<FrameRing["peek"]> {
    if(this.writer)throw protocolError("Frame sender cannot read its queue");
    const recordEnds:number[]=[];let length=0;
    for(const chunk of this.#chunks) {
      let offset=chunk.offset;
      for(const end of chunk.ends) {
        if(end<=offset)continue;
        const recordLength=end-offset;if(length+recordLength>destination.length)return {length,recordEnds};
        destination.set(chunk.bytes.subarray(offset,end),length);length+=recordLength;recordEnds.push(length);offset=end;
      }
    }
    return {length,recordEnds};
  }
  advance(bytes:number):void {
    if(this.writer||!Number.isSafeInteger(bytes)||bytes<0||bytes>this.#used)throw protocolError("Invalid frame queue consumption");
    if(bytes===0)return;
    let remaining=bytes;
    for(const chunk of this.#chunks) {
      const length=chunk.bytes.length-chunk.offset;
      if(remaining<length) {if(!chunk.ends.includes(chunk.offset+remaining))throw protocolError("Frame consumption splits a record");break;}
      remaining-=length;if(remaining===0)break;
    }
    remaining=bytes;
    while(remaining>0) {
      const chunk=this.#chunks[0];if(chunk===undefined)throw protocolError("Frame consumption exceeds queue");
      const consumed=Math.min(remaining,chunk.bytes.length-chunk.offset);chunk.offset+=consumed;remaining-=consumed;
      if(chunk.offset===chunk.bytes.length)this.#chunks.shift();
    }
    this.#used-=bytes;this.#send("frame-credit",{direction:this.#direction,sequence:this.#creditSequence++,bytes});
  }
  skipAll():void {if(this.writer)throw protocolError("Only a frame receiver drops queued frames");this.advance(this.#used);}
  reset():void {this.#chunks.length=0;this.#sentEnds=[];this.#sentCursor=0;this.#used=0;this.#sent=0;this.#credited=0;this.#sequence=0;this.#received=0;this.#creditSequence=0;this.#receivedCredit=0;}
}
