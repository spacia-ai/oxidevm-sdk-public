import { exactKeys, integer, record, string } from "../decode.js";
import { VMError, serializeUnknownError, deserializeError, decodeSerializedError } from "../errors.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { networkErrno } from "../relay-errors.js";
import { UserspaceRelay } from "./userspace-relay.js";
import type { RelayRuntimeAdapter } from "./network-connection.js";
import type {
  UserspaceNetworkHostCompletion,
  UserspaceNetworkHostRequest,
  UserspaceNetworkOperation,
} from "../userspace-abi.js";
import type { RelayConnection } from "./relay-protocol.js";
import {
  PreviewRuntimeClient,
  PreviewRuntimeServer,
  type PreviewRuntimeHandler,
} from "./preview-runtime-channel.js";

const MAX_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

type Request = UserspaceNetworkHostRequest & { readonly sequence: number };
type Response = {
  readonly sequence: number;
  readonly generation: bigint;
  readonly id: bigint;
  readonly completion: UserspaceNetworkHostCompletion;
};

export class UserspaceNetworkClient {
  readonly #port: MessagePort;
  #next = 1;
  readonly #pending = new Map<number, {
    readonly generation: bigint;
    readonly id: bigint;
    resolve(value: UserspaceNetworkHostCompletion): void;
    reject(error: Error): void;
  }>();
  #previewHandler: PreviewRuntimeHandler | undefined;
  readonly #previewServer: PreviewRuntimeServer;

  readonly #configure: (enabled:boolean,generation:number)=>void|Promise<void>;
  #policyGeneration=0;

  constructor(port: MessagePort, configure:(enabled:boolean,generation:number)=>void|Promise<void>=()=>{}) {
    this.#configure=configure;
    this.#port = port;
    this.#previewServer = new PreviewRuntimeServer(port, (operation, signal) => this.#previewHandler?.(operation, signal) ?? { kind: "error", code: "channel" });
    port.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    port.start();
  }

  request(request: UserspaceNetworkHostRequest, signal?: AbortSignal): Promise<UserspaceNetworkHostCompletion> {
    const sequence = this.#next++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new VMError("ABORTED", "network operation aborted"));
        return;
      }
      const abort = () => {
        this.#pending.delete(sequence);
        this.#port.postMessage({
          version: PROTOCOL_VERSION,
          kind: "cancel",
          sequence,
          generation: request.generation,
          id: request.id,
        });
        reject(new VMError("ABORTED", "network operation aborted"));
      };
      this.#pending.set(sequence, {
        generation: request.generation,
        id: request.id,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject:(error)=>{signal?.removeEventListener("abort",abort);reject(error);},
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.#port.postMessage({ version: PROTOCOL_VERSION, ...request, sequence });
    });
  }

  close(): void {
    this.#previewServer.close();
    this.#port.close();
    for (const pending of this.#pending.values()) pending.reject(new VMError("ABORTED", "network channel closed"));
    this.#pending.clear();
  }

  servePreview(
    handler: PreviewRuntimeHandler,
  ): void {
    this.#previewHandler = handler;
  }

  #receive(value: unknown): void {
    const candidate=record(value,"network channel message");
    if(candidate["kind"]==="relay-policy") {
      exactKeys(candidate,["kind","version","generation","enabled"]);
      const generation=integer(candidate["generation"],"relay generation",1);
      const enabled=candidate["enabled"];
      if(candidate["version"]!==PROTOCOL_VERSION||typeof enabled!=="boolean"||generation<=this.#policyGeneration)throw new VMError("PROTOCOL_ERROR","Invalid relay policy generation");
      this.#policyGeneration=generation;
      void Promise.resolve().then(()=>this.#configure(enabled,generation)).then(
        ()=>this.#port.postMessage({kind:"relay-policy-ack",version:PROTOCOL_VERSION,generation,ok:true}),
        (error:unknown)=>this.#port.postMessage({kind:"relay-policy-ack",version:PROTOCOL_VERSION,generation,ok:false,error:serializeUnknownError(error)}),
      );return;
    }
    if (this.#previewServer.receive(value)) return;
    const response = decodeResponse(value);
    const pending = this.#pending.get(response.sequence);
    if (pending === undefined) return;
    this.#pending.delete(response.sequence);
    if (pending.generation !== response.generation || pending.id !== response.id) {
      pending.reject(new VMError("PROTOCOL_ERROR", "network response identity is stale"));
      return;
    }
    pending.resolve(response.completion);
  }
}

export function serveUserspaceNetwork(port:MessagePort):UserspaceNetworkServer {return new UserspaceNetworkServer(port);}

export class UserspaceNetworkServer implements RelayRuntimeAdapter {
  readonly preview:PreviewRuntimeClient;
  readonly #port:MessagePort;
  readonly #sockets=new UserspaceRelay();
  readonly #active=new Map<number,{generation:bigint;id:bigint;controller:AbortController;bytes:number}>();
  #pendingBytes=0;
  #policy:{generation:number;resolve():void;reject(error:Error):void}|undefined;
  constructor(port:MessagePort) {
    this.#port=port;this.preview=new PreviewRuntimeClient(port);
    port.onmessage=(event:MessageEvent<unknown>)=>this.#receive(event.data);port.start();
  }
  async setRelay(connection:RelayConnection|undefined,generation:number):Promise<void> {
    this.#sockets.setRelay(connection,generation);
    for(const operation of this.#active.values())operation.controller.abort();this.#active.clear();this.#pendingBytes=0;
    if(this.#policy!==undefined)throw new VMError("PROTOCOL_ERROR","Relay policy change is already pending");
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#policy=undefined;reject(new VMError("RELAY_ERROR","Runtime network policy acknowledgement timed out"));},5000);
      this.#policy={generation,resolve:()=>{clearTimeout(timer);resolve();},reject:(error)=>{clearTimeout(timer);reject(error);}};
      this.#port.postMessage({kind:"relay-policy",version:PROTOCOL_VERSION,generation,enabled:connection!==undefined});
    });
  }
  close():void {
    for(const operation of this.#active.values())operation.controller.abort();this.#active.clear();this.#pendingBytes=0;
    this.#policy?.reject(new VMError("ABORTED","Network channel closed"));this.#policy=undefined;this.#port.close();
  }
  #receive(value:unknown):void {
    if(this.preview.receive(value))return;
    const input=record(value,"network message");
    if(input["kind"]==="relay-policy-ack") {
      exactKeys(input,["kind","version","generation","ok"],["error"]);
      const pending=this.#policy;
      if(pending===undefined||input["version"]!==PROTOCOL_VERSION||input["generation"]!==pending.generation)throw new VMError("PROTOCOL_ERROR","Stale relay policy acknowledgement");
      this.#policy=undefined;
      if(input["ok"]===true){exactKeys(input,["kind","version","generation","ok"]);pending.resolve();}
      else if(input["ok"]===false)pending.reject(deserializeError(decodeSerializedError(input["error"])));
      else throw new VMError("PROTOCOL_ERROR","Invalid relay policy acknowledgement");
      return;
    }
    const cancellation=decodeCancellation(value);
    if(cancellation!==undefined) {
      const operation=this.#active.get(cancellation.sequence);
      if(operation?.generation===cancellation.generation&&operation.id===cancellation.id){operation.controller.abort();this.#drop(cancellation.sequence);}return;
    }
    const request=decodeRequest(value);
    const bytes = request.operation.kind === "send" || request.operation.kind === "send-to" ? request.operation.bytes.byteLength : 0;
    if(this.#active.has(request.sequence)||this.#active.size>=128||this.#pendingBytes+bytes>MAX_PENDING_BYTES) {this.#reply(request,{kind:"error",errno:11});return;}
    const controller=new AbortController();this.#active.set(request.sequence,{generation:request.generation,id:request.id,controller,bytes});this.#pendingBytes+=bytes;
    void this.#sockets.execute(request.generation,request.operation,controller.signal).then(
      completion=>{if(this.#drop(request.sequence))this.#reply(request,completion);},
      (error:unknown)=>{if(this.#drop(request.sequence))this.#reply(request,{kind:"error",errno:networkErrno(error)});},
    );
  }
  #drop(sequence:number):boolean {
    const operation=this.#active.get(sequence);if(operation===undefined)return false;
    this.#active.delete(sequence);this.#pendingBytes-=operation.bytes;return true;
  }
  #reply(request:Request,completion:UserspaceNetworkHostCompletion):void {this.#port.postMessage({version:PROTOCOL_VERSION,sequence:request.sequence,generation:request.generation,id:request.id,completion});}
}

function decodeCancellation(value: unknown): { readonly sequence: number; readonly generation: bigint; readonly id: bigint } | undefined {
  const candidate = record(value, "Userspace network message");
  if (candidate["kind"] !== "cancel") return undefined;
  exactKeys(candidate, ["version", "kind", "sequence", "generation", "id"]);
  if(candidate["version"]!==PROTOCOL_VERSION)throw new VMError("PROTOCOL_ERROR","Network protocol version mismatch");
  if (typeof candidate["generation"] !== "bigint" || typeof candidate["id"] !== "bigint") throw new TypeError("invalid network cancellation identity");
  return {
    sequence: integer(candidate["sequence"], "network cancellation sequence", 1),
    generation: candidate["generation"],
    id: candidate["id"],
  };
}

function decodeRequest(value: unknown): Request {
  const request = record(value, "Userspace network request");
  exactKeys(request, ["version", "kind", "generation", "id", "operation", "sequence"]);
  if(request["version"]!==PROTOCOL_VERSION)throw new VMError("PROTOCOL_ERROR","Network protocol version mismatch");
  if (request["kind"] !== "network" || typeof request["generation"] !== "bigint" || typeof request["id"] !== "bigint") {
    throw new TypeError("invalid Userspace network identity");
  }
  return {
    kind: "network",
    generation: request["generation"],
    id: request["id"],
    sequence: integer(request["sequence"], "network sequence", 1),
    operation: decodeOperation(request["operation"]),
  };
}

function decodeOperation(value: unknown): UserspaceNetworkOperation {
  const operation = record(value, "Userspace network operation");
  const kind = string(operation["kind"], "network operation kind");
  const socket = typeof operation["socket"] === "bigint" && operation["socket"] > 0n ? operation["socket"] : undefined;
  if (socket === undefined) throw new TypeError("invalid network socket");
  switch (kind) {
    case "connect": {
      exactKeys(operation, ["kind", "socket", "family", "address", "port"]);
      const family = integer(operation["family"], "network family");
      const address = operation["address"];
      if ((family !== 2 && family !== 10) || !(address instanceof Uint8Array) || address.byteLength !== 16) throw new TypeError("invalid network address");
      return { kind, socket, family, address, port: integer(operation["port"], "network port", 1, 65_535) };
    }
    case "send":
      exactKeys(operation, ["kind", "socket", "bytes"]);
      if (!(operation["bytes"] instanceof Uint8Array) || operation["bytes"].byteLength > MAX_BYTES) throw new TypeError("invalid network payload");
      return { kind, socket, bytes: operation["bytes"] };
    case "send-to": {
      exactKeys(operation, ["kind", "socket", "family", "address", "port", "bytes"]);
      const family = integer(operation["family"], "network family");
      const address = operation["address"];
      const bytes = operation["bytes"];
      if ((family !== 2 && family !== 10) || !(address instanceof Uint8Array) || address.byteLength !== 16 || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new TypeError("invalid network datagram");
      return { kind, socket, family, address, port: integer(operation["port"], "network port", 1, 65_535), bytes };
    }
    case "receive":
      exactKeys(operation, ["kind", "socket", "maxBytes"]);
      return { kind, socket, maxBytes: integer(operation["maxBytes"], "network receive length", 0, MAX_BYTES) };
    case "receive-from":
      exactKeys(operation, ["kind", "socket", "maxBytes"]);
      return { kind, socket, maxBytes: integer(operation["maxBytes"], "network datagram receive length", 0, MAX_BYTES) };
    case "shutdown":
      exactKeys(operation, ["kind", "socket", "how"]);
      return { kind, socket, how: decodeShutdownMode(operation["how"]) };
    case "close":
      exactKeys(operation, ["kind", "socket"]);
      return { kind, socket };
    default:
      throw new TypeError("unknown network operation");
  }
}

function decodeResponse(value: unknown): Response {
  const response = record(value, "Userspace network response");
  exactKeys(response, ["version", "sequence", "generation", "id", "completion"]);
  if(response["version"]!==PROTOCOL_VERSION)throw new VMError("PROTOCOL_ERROR","Network protocol version mismatch");
  if (typeof response["generation"] !== "bigint" || typeof response["id"] !== "bigint") throw new TypeError("invalid network response identity");
  return {
    sequence: integer(response["sequence"], "network response sequence", 1),
    generation: response["generation"],
    id: response["id"],
    completion: decodeCompletion(response["completion"]),
  };
}

function decodeCompletion(value: unknown): UserspaceNetworkHostCompletion {
  const completion = record(value, "Userspace network completion");
  const kind = string(completion["kind"], "network completion kind");
  if (kind === "connected" || kind === "shutdown" || kind === "closed") {
    exactKeys(completion, ["kind"]);
    return { kind };
  }
  if (kind === "sent") {
    exactKeys(completion, ["kind", "bytes"]);
    return { kind, bytes: integer(completion["bytes"], "sent bytes", 0, MAX_BYTES) };
  }
  if (kind === "received") {
    exactKeys(completion, ["kind", "bytes"]);
    if (!(completion["bytes"] instanceof Uint8Array) || completion["bytes"].byteLength > MAX_BYTES) throw new TypeError("invalid received bytes");
    return { kind, bytes: completion["bytes"] };
  }
  if (kind === "received-from") {
    exactKeys(completion, ["kind", "family", "address", "port", "bytes"]);
    const family = integer(completion["family"], "network family");
    const address = completion["address"];
    const bytes = completion["bytes"];
    if ((family !== 2 && family !== 10) || !(address instanceof Uint8Array) || address.byteLength !== 16 || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new TypeError("invalid received datagram");
    return { kind, family, address, port: integer(completion["port"], "network port", 1, 65_535), bytes };
  }
  if (kind === "error") {
    exactKeys(completion, ["kind", "errno"]);
    return { kind, errno: decodeNetworkErrno(completion["errno"]) };
  }
  throw new TypeError("unknown network completion");
}

function decodeShutdownMode(value: unknown): 0 | 1 | 2 {
  const mode = integer(value, "network shutdown mode", 0, 2);
  if (mode === 0 || mode === 1 || mode === 2) return mode;
  throw new TypeError("invalid network shutdown mode");
}

function decodeNetworkErrno(value: unknown): 1 | 4 | 5 | 11 | 22 | 32 | 93 | 95 | 101 | 104 | 113 | 107 | 110 | 111 | 114 | 115 {
  const errno = integer(value, "network errno");
  switch (errno) {
    case 1: case 4: case 5: case 11: case 22: case 32: case 93:
    case 95: case 101: case 104: case 113: case 107: case 110: case 111: case 114: case 115:
      return errno;
    default:
      throw new TypeError("invalid network errno");
  }
}
