import type { UserspaceNetworkHostCompletion, UserspaceNetworkOperation } from "../userspace-abi.js";
import type { RelayConnection, RelayPeer } from "./relay-protocol.js";

interface Socket { readonly peer:RelayPeer; readonly stream:bigint; readonly connection:RelayConnection; readonly relayGeneration:number }
interface Opening {readonly peer:RelayPeer;readonly controller:AbortController;readonly promise:Promise<Socket>}

export class UserspaceRelay {
  readonly #sockets=new Map<string,Socket>();
  readonly #opening=new Map<string,Opening>();
  #connection:RelayConnection|undefined;
  #generation=0;
  setRelay(connection:RelayConnection|undefined,generation:number):void {
    for(const opening of this.#opening.values())opening.controller.abort();this.#opening.clear();
    for(const socket of this.#sockets.values())socket.connection.close(socket.stream);
    this.#sockets.clear();this.#connection=connection;this.#generation=generation;
  }
  async execute(generation:bigint,operation:UserspaceNetworkOperation,signal:AbortSignal):Promise<UserspaceNetworkHostCompletion> {
    const key=`${generation.toString()}:${operation.socket.toString()}`;
    const connection=this.#connection;const relayGeneration=this.#generation;
    if(operation.kind==="close"){this.#opening.get(key)?.controller.abort();this.#opening.delete(key);const socket=this.#sockets.get(key);if(socket!==undefined)socket.connection.close(socket.stream);this.#sockets.delete(key);return {kind:"closed"};}
    if(connection===undefined)return {kind:"error",errno:1};
    if(operation.kind==="connect" || operation.kind==="send-to") {
      const transport=operation.kind==="connect"?"tcp":"udp";
      const logicalDns=transport==="udp"&&operation.family===2&&operation.port===53&&operation.address.slice(0,4).every((byte,index)=>byte===[192,0,2,1][index]);
      if(!allowedPort(transport,operation.port)||(!logicalDns&&blockedAddress(operation.family,operation.address)))return {kind:"error",errno:1};
      let socket=this.#sockets.get(key);
      if(socket===undefined) {
        const peer:RelayPeer={transport,family:operation.family,address:operation.address.slice(),port:operation.port};
        let opening=this.#opening.get(key);
        if(opening!==undefined&&!sameDestination(opening.peer,peer))return {kind:"error",errno:95};
        if(opening===undefined){
          const controller=new AbortController();const lifetime=AbortSignal.any([signal,controller.signal]);
          const promise=connection.openSocket(peer,lifetime).then(stream=>{
            if(lifetime.aborted||connection!==this.#connection||relayGeneration!==this.#generation){connection.close(stream);throw new DOMException("Socket opening cancelled","AbortError");}
            const socket={peer,stream,connection,relayGeneration};this.#sockets.set(key,socket);return socket;
          });
          opening={peer,controller,promise};this.#opening.set(key,opening);
          const entry=opening;
          void promise.finally(()=>{if(this.#opening.get(key)===entry)this.#opening.delete(key);}).catch(()=>{});
        }
        socket=await opening.promise;
      } else if(operation.kind==="connect"||!samePeer(socket.peer,operation))return {kind:"error",errno:95};
      if(operation.kind==="connect")return {kind:"connected"};
      await connection.send(socket.stream,operation.bytes,signal);return {kind:"sent",bytes:operation.bytes.byteLength};
    }
    const socket=this.#sockets.get(key)??await this.#opening.get(key)?.promise;
    if(socket===undefined||socket.connection!==connection||socket.relayGeneration!==relayGeneration)return {kind:"error",errno:107};
    switch(operation.kind) {
      case "send":await connection.send(socket.stream,operation.bytes,signal);return {kind:"sent",bytes:operation.bytes.byteLength};
      case "receive":return {kind:"received",bytes:await connection.receive(socket.stream,operation.maxBytes,signal)};
      case "receive-from":{const bytes=await connection.receive(socket.stream,operation.maxBytes,signal);return {kind:"received-from",bytes,family:socket.peer.family,address:socket.peer.address,port:socket.peer.port};}
      case "shutdown":connection.shutdown(socket.stream,operation.how);return {kind:"shutdown"};
    }
  }
}

function blockedAddress(family: 2 | 10, address: Uint8Array): boolean {
  if (family === 2) {
    const value = new DataView(address.buffer, address.byteOffset, 4).getUint32(0, false);
    return IPV4_BLOCKS.some(([network, prefix]) => {
      const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
      return (value & mask) === (network & mask);
    });
  }
  const allZero = address.every((byte) => byte === 0);
  const loopback = address.slice(0, 15).every((byte) => byte === 0) && address[15] === 1;
  const first = address[0] ?? 0;
  const second = address[1] ?? 0;
  const ipv4Mapped = address.slice(0, 10).every((byte) => byte === 0) && address[10] === 0xff && address[11] === 0xff;
  const documentation = first === 0x20 && second === 0x01 && address[2] === 0x0d && address[3] === 0xb8;
  return allZero
    || loopback
    || address.slice(0, 12).every((byte) => byte === 0)
    || (ipv4Mapped && blockedAddress(2, address.slice(12)))
    || (first & 0xfe) === 0xfc
    || (first === 0xfe && (second & 0xc0) === 0x80)
    || first === 0xff
    || documentation;
}

const IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x0000_0000, 8], [0x0a00_0000, 8], [0x6440_0000, 10], [0x7f00_0000, 8],
  [0xa9fe_0000, 16], [0xac10_0000, 12], [0xc000_0000, 24], [0xc000_0200, 24],
  [0xc058_6300, 24], [0xc0a8_0000, 16], [0xc612_0000, 15], [0xc633_6400, 24],
  [0xcb00_7100, 24], [0xe000_0000, 4], [0xf000_0000, 4],
];

function allowedPort(transport: "tcp" | "udp", port: number): boolean {
  return transport === "tcp" ? port === 80 || port === 443 : port === 53;
}

function samePeer(peer: RelayPeer, operation: Extract<UserspaceNetworkOperation, { kind: "send-to" }>): boolean {
  return peer.transport === "udp"
    && peer.family === operation.family
    && peer.port === operation.port
    && peer.address.every((byte, index) => byte === operation.address[index]);
}
function sameDestination(left:RelayPeer,right:RelayPeer):boolean {
  return left.transport===right.transport&&left.family===right.family&&left.port===right.port&&left.address.every((byte,index)=>byte===right.address[index]);
}
