import { exactKeys, record } from "../decode.js";
import { decodeRelayFetchHeaders, relayFetchPayload, type RelayFetchHeaders, type RelayFetchOptions } from "./relay-fetch.js";
import { VMError } from "../errors.js";
import { decodeRelayFailure, relayError, relayFailure } from "../relay-errors.js";
import {
  decodeRelayFrame, decodeRelayReady, encodeRelayFrame, RelayKind,
  RELAY_BUFFER_LIMIT, RELAY_MAX_CREDIT, RELAY_MAX_FRAME, RELAY_STREAM_LIMIT,
  type RelayFrame, type RelayIdentity, type RelayTicket,
} from "./relay-wire.js";
import type { RelayFailureReason } from "../network-types.js";

export interface RelayPeer {
  readonly transport: "tcp" | "udp";
  readonly family: 2 | 10;
  readonly address: Uint8Array;
  readonly port: number;
}
interface Waiter { resolve(): void; reject(error: Error): void }
interface Writer extends Waiter { readonly bytes: Uint8Array; offset: number }
interface StreamState {
  readonly peer: RelayPeer | {readonly transport:"https"};
  outgoing: bigint;
  incoming: bigint;
  sendCredit: number;
  receiveCredit: number;
  opened: boolean;
  readClosed: boolean;
  readShutdown: boolean;
  writeClosed: boolean;
  readonly received: Uint8Array[];
  readonly readers: Waiter[];
  readonly writers: Writer[];
  readonly opening: Waiter;
  readonly fetchHeaders?: {resolve(headers:RelayFetchHeaders):void;reject(error:unknown):void};
  headersReceived?: boolean;
}
type ClosedStreamState = { incoming: bigint; barrier: bigint | undefined };
const EMPTY = new Uint8Array();
const INITIAL_CREDIT = RELAY_BUFFER_LIMIT / RELAY_STREAM_LIMIT;

/** One authenticated session. Socket identities cannot be reused within it. */
export class RelayConnection {
  readonly #socket: WebSocket;
  readonly #session: bigint;
  readonly expiresAt: number;
  readonly #streams = new Map<bigint, StreamState>();
  readonly #closedStreams = new Map<bigint, ClosedStreamState>();
  readonly #outbound: ArrayBuffer[] = [];
  readonly #onClose: (reason: RelayFailureReason) => void;
  #lastStream = 0n;
  #pendingBytes = 0;
  #queuedBytes = 0;
  #receivedBytes = 0;
  #closed = false;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #lastActivity = Date.now();
  #ping = 0n;
  #pong = -1n;
  #peerPing = 0n;
  #retirementQueued = false;

  private constructor(socket: WebSocket, ready: { session: bigint; expiresAt: number }, onClose: (reason: RelayFailureReason) => void) {
    this.#socket = socket;
    this.#session = ready.session;
    this.expiresAt = ready.expiresAt;
    this.#onClose = onClose;
    socket.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    socket.onclose = () => this.#fail(relayError("disconnected"));
    socket.onerror = () => this.#fail(relayError("disconnected"));
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastActivity > 45000 || Date.now() >= this.expiresAt) this.#fail(relayError("timed-out"));
      else this.#send(RelayKind.PING, 0n, this.#ping++, EMPTY, 0);
    }, 15000);
  }

  static async connect(ticket: RelayTicket, identity: RelayIdentity, signal: AbortSignal, onClose: (reason: RelayFailureReason) => void = () => {}): Promise<RelayConnection> {
    aborted(signal);
    const url = new URL(ticket.webSocketUrl);
    if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "" || ticket.expiresAt <= Date.now()) throw relayError("authentication-failed");
    const socket = new WebSocket(url, "oxidevm-relay-v2");
    socket.binaryType = "arraybuffer";
    const ready = await new Promise<{ session: bigint; expiresAt: number }>((resolve, reject) => {
      const finish = (error?: Error, result?: { session: bigint; expiresAt: number }) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
        if (result !== undefined) resolve(result);
        else { socket.close(); reject(error ?? relayError("authentication-failed")); }
      };
      const abort = () => finish(new VMError("ABORTED", "Relay connection cancelled"));
      const timeout = setTimeout(() => finish(relayError("timed-out")), 5000);
      signal.addEventListener("abort", abort, { once: true });
      socket.onopen = () => socket.send(JSON.stringify({ version: 2, ticket: ticket.ticket, ...identity }));
      socket.onerror = socket.onclose = () => finish(relayError("authentication-failed"));
      socket.onmessage = (event: MessageEvent<unknown>) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 1024) throw relayError("protocol-error");
          const value: unknown = JSON.parse(event.data);
          const message=record(value,"relay authentication response");
          if (message["reason"] !== undefined) {
            exactKeys(message,["version","reason"]);if(message["version"]!==2)throw relayError("version-mismatch");
            throw relayError(decodeRelayFailure(message["reason"]));
          }
          finish(undefined, decodeRelayReady(value));
        } catch (error: unknown) { finish(error instanceof Error ? error : relayError("protocol-error")); }
      };
    });
    if (socket.readyState !== 1) throw relayError("disconnected");
    return new RelayConnection(socket, ready, onClose);
  }

  open(stream: bigint, peer: RelayPeer, signal: AbortSignal): Promise<void> {
    aborted(signal);
    if (this.#closed) return Promise.reject(relayError("disconnected"));
    if (stream <= this.#lastStream || stream > 0xffffffffffffffffn || peer.address.byteLength !== 16) return Promise.reject(relayError("protocol-error"));
    if (this.#streams.size >= RELAY_STREAM_LIMIT || this.#streams.size + this.#closedStreams.size >= RELAY_STREAM_LIMIT * 2) return Promise.reject(relayError("quota-exceeded"));
    if ((peer.transport === "tcp" && peer.port !== 80 && peer.port !== 443) || (peer.transport === "udp" && peer.port !== 53)) return Promise.reject(relayError("destination-denied"));
    this.#lastStream = stream;
    return new Promise<void>((resolve, reject) => {
      const abort = () => { this.close(stream); reject(new VMError("ABORTED", "Relay open cancelled")); };
      const finish = () => signal.removeEventListener("abort", abort);
      const state: StreamState = {
        peer, outgoing: 1n, incoming: 0n, sendCredit: 0, receiveCredit: INITIAL_CREDIT,
        opened: false, readClosed: false, readShutdown: false, writeClosed: false, received: [], readers: [], writers: [],
        opening: { resolve: () => { finish(); resolve(); }, reject: (error) => { finish(); reject(error); } },
      };
      this.#streams.set(stream, state);
      signal.addEventListener("abort", abort, { once: true });
      const payload = new Uint8Array(20);
      payload[0] = peer.transport === "tcp" ? 6 : 17;
      payload[1] = peer.family;
      new DataView(payload.buffer).setUint16(2, peer.port, false);
      payload.set(peer.address, 4);
      this.#send(RelayKind.OPEN, stream, 0n, payload, INITIAL_CREDIT);
    });
  }

  async openSocket(peer: RelayPeer, signal: AbortSignal): Promise<bigint> {
    const stream=this.#lastStream+1n;await this.open(stream,peer,signal);return stream;
  }

  async fetch(target: string, options: RelayFetchOptions, signal: AbortSignal): Promise<Response> {
    aborted(signal); const payload=relayFetchPayload(target,options);
    if(this.#closed)throw relayError("disconnected");
    if(this.#streams.size>=RELAY_STREAM_LIMIT||this.#streams.size+this.#closedStreams.size>=RELAY_STREAM_LIMIT*2)throw relayError("quota-exceeded");
    const stream=++this.#lastStream;
    const headers=Promise.withResolvers<RelayFetchHeaders>();
    const abort=()=>{this.close(stream);headers.reject(new VMError("ABORTED","Relay fetch cancelled"));};
    const finish=()=>signal.removeEventListener("abort",abort);
    const state:StreamState={peer:{transport:"https"},outgoing:1n,incoming:0n,sendCredit:0,receiveCredit:INITIAL_CREDIT,opened:false,readClosed:false,readShutdown:false,writeClosed:true,received:[],readers:[],writers:[],opening:{resolve:()=>{},reject:error=>{finish();headers.reject(error);}},fetchHeaders:headers,headersReceived:false};
    this.#streams.set(stream,state);signal.addEventListener("abort",abort,{once:true});
    this.#send(RelayKind.FETCH,stream,0n,payload,INITIAL_CREDIT);
    try {
      const metadata=await headers.promise;
      if([204,205,304].includes(metadata.status)){finish();this.close(stream);return new Response(null,metadata);}
      const receive=(maximum:number)=>this.receive(stream,maximum,signal);
      const close=()=>this.close(stream);
      let received=0;
      const body=new ReadableStream({type:"bytes",async pull(controller) {
        try {
          const request=controller.byobRequest;const view=request?.view;
          const bytes=await receive(Math.min(view?.byteLength??65536,65536));
          received+=bytes.length;if(received>options.maximumBytes)throw relayError("quota-exceeded");
          if(bytes.length===0){controller.close();request?.respond(0);finish();close();}
          else if(request!==null&&view!==null&&view!==undefined){new Uint8Array(view.buffer,view.byteOffset,view.byteLength).set(bytes);request.respond(bytes.length);}
          else controller.enqueue(bytes);
        } catch(error:unknown){finish();close();controller.error(error);}
      },cancel(){finish();close();}});
      return new Response(body,metadata);
    } catch(error:unknown){finish();this.close(stream);throw error;}
  }

  async send(stream: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    aborted(signal);
    const state = this.#state(stream);
    if (!state.opened || state.writeClosed) throw relayError("disconnected");
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > 1048576 || (state.peer.transport === "udp" && bytes.byteLength > 4096)
      || this.#pendingBytes + this.#queuedBytes + this.#socket.bufferedAmount + bytes.byteLength > RELAY_BUFFER_LIMIT || state.writers.length >= 64) throw relayError("quota-exceeded");
    this.#pendingBytes += bytes.byteLength;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = state.writers.indexOf(writer);
        if (index >= 0) { state.writers.splice(index, 1); this.#pendingBytes -= writer.bytes.byteLength; }
        writer.reject(new VMError("ABORTED", "Relay write cancelled"));
      };
      const finish = () => signal.removeEventListener("abort", abort);
      const writer: Writer = { bytes, offset: 0, resolve: () => { finish(); resolve(); }, reject: (error) => { finish(); reject(error); } };
      state.writers.push(writer);
      signal.addEventListener("abort", abort, { once: true });
      this.#flushWriters(stream, state);
    });
  }

  async receive(stream: bigint, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    aborted(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1048576) throw relayError("protocol-error");
    const state = this.#state(stream);
    if (maxBytes === 0) return EMPTY;
    while (state.received.length === 0 && !state.readClosed && !state.readShutdown) {
      if (state.readers.length >= 64) throw relayError("quota-exceeded");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { const i = state.readers.indexOf(reader); if (i >= 0) state.readers.splice(i, 1); reader.reject(new VMError("ABORTED", "Relay read cancelled")); };
        const finish = () => signal.removeEventListener("abort", abort);
        const reader = { resolve: () => { finish(); resolve(); }, reject: (error: Error) => { finish(); reject(error); } };
        state.readers.push(reader);
        signal.addEventListener("abort", abort, { once: true });
      });
      this.#state(stream);
    }
    const bytes = state.received.shift();
    if (bytes === undefined) return EMPTY;
    const head = bytes.slice(0, maxBytes);
    const consumed = state.peer.transport === "udp" ? bytes.byteLength : head.byteLength;
    if (consumed < bytes.byteLength) state.received.unshift(bytes.subarray(consumed));
    this.#receivedBytes -= consumed;
    state.receiveCredit += consumed;
    this.#send(RelayKind.WINDOW, stream, state.outgoing++, EMPTY, consumed);
    return head;
  }

  shutdown(stream: bigint, how: 0 | 1 | 2 = 1): void {
    const state = this.#state(stream);
    if (how !== 1) {
      state.readShutdown = true;
      const discarded = state.received.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      this.#receivedBytes -= discarded;
      state.received.length = 0;
      for (const reader of state.readers.splice(0)) reader.resolve();
    }
    if (how !== 0) { state.writeClosed = true; this.#rejectWriters(state, relayError("disconnected")); }
    this.#send(RelayKind.HALF_CLOSE, stream, state.outgoing++, new Uint8Array([how]), 0);
  }

  close(stream: bigint, reason: RelayFailureReason = "disconnected"): void {
    const state = this.#streams.get(stream);
    if (state === undefined) return;
    if (!this.#closed) this.#send(RelayKind.RESET, stream, state.outgoing++, new TextEncoder().encode(reason), 0);
    this.#removeStream(stream, state, relayError(reason));
  }

  dispose(): void { this.#fail(relayError("disconnected")); }

  #state(stream: bigint): StreamState {
    const state = this.#streams.get(stream);
    if (this.#closed || state === undefined) throw relayError("disconnected");
    return state;
  }
  #flushWriters(stream: bigint, state: StreamState): void {
    while (state.writers[0] !== undefined && state.sendCredit > 0 && !state.writeClosed) {
      const writer = state.writers[0];
      const remaining = writer.bytes.byteLength - writer.offset;
      if (state.peer.transport === "udp" && state.sendCredit < remaining) break;
      const length = Math.min(remaining, state.sendCredit, RELAY_MAX_FRAME);
      const payload = writer.bytes.subarray(writer.offset, writer.offset + length);
      writer.offset += length; state.sendCredit -= length;
      this.#send(RelayKind.DATA, stream, state.outgoing++, payload, 0);
      if (writer.offset === writer.bytes.byteLength) { state.writers.shift(); this.#pendingBytes -= writer.bytes.byteLength; writer.resolve(); }
    }
  }
  #send(kind: number, stream: bigint, sequence: bigint, payload: Uint8Array, window: number): void {
    if (this.#closed) return;
    const frame = encodeRelayFrame({ kind, session: this.#session, stream, sequence, payload, window });
    if (this.#queuedBytes + this.#pendingBytes + this.#socket.bufferedAmount + frame.byteLength > RELAY_BUFFER_LIMIT) { this.#fail(relayError("quota-exceeded")); return; }
    this.#outbound.push(frame); this.#queuedBytes += frame.byteLength;
    this.#drain();
  }
  #drain(): void {
    if (this.#closed) return;
    try {
      while (this.#outbound[0] !== undefined && this.#socket.bufferedAmount < RELAY_MAX_CREDIT) {
        const frame = this.#outbound.shift();
        if (frame === undefined) break;
        this.#queuedBytes -= frame.byteLength;
        this.#socket.send(frame);
      }
    } catch { this.#fail(relayError("disconnected")); }
    if (this.#outbound.length > 0 && this.#drainTimer === undefined) {
      this.#drainTimer = setTimeout(() => { this.#drainTimer = undefined; this.#drain(); }, 20);
    }
  }
  #receive(value: unknown): void {
    try {
      if (!(value instanceof ArrayBuffer)) throw relayError("protocol-error");
      const frame = decodeRelayFrame(value, this.#session);
      this.#lastActivity = Date.now();
      if (frame.kind === RelayKind.PING) {
        if (frame.sequence !== this.#peerPing++) throw relayError("protocol-error");
        this.#send(RelayKind.PONG, 0n, frame.sequence, EMPTY, 0); return;
      }
      if (frame.kind === RelayKind.PONG) {
        if (frame.sequence <= this.#pong || frame.sequence >= this.#ping) throw relayError("protocol-error");
        this.#pong = frame.sequence;
        for (const [stream, closed] of this.#closedStreams) if (closed.barrier !== undefined && closed.barrier <= frame.sequence) this.#closedStreams.delete(stream);
        return;
      }
      const state = this.#streams.get(frame.stream);
      if (state === undefined) {
        const closed = this.#closedStreams.get(frame.stream);
        if (closed === undefined || closed.incoming !== frame.sequence) throw relayError("protocol-error");
        closed.incoming++; return;
      }
      if (frame.sequence !== state.incoming++) throw relayError("protocol-error");
      this.#streamFrame(frame, state);
    } catch (error) { this.#fail(error); }
  }
  #streamFrame(frame: RelayFrame, state: StreamState): void {
    if (frame.kind === RelayKind.RESET) {
      const reason = decodeRelayFailure(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
      this.#removeStream(frame.stream, state, relayError(reason)); return;
    }
    if (frame.kind === RelayKind.OPENED && !state.opened && frame.sequence === 0n) {
      if ([...this.#streams.values()].reduce((total,stream)=>total+stream.sendCredit,frame.window)>RELAY_BUFFER_LIMIT)throw relayError("protocol-error");
      state.opened = true; state.sendCredit = frame.window; state.opening.resolve(); return;
    }
    if (!state.opened) throw relayError("protocol-error");
    if (frame.kind === RelayKind.FETCH_HEADERS) {
      if(state.fetchHeaders===undefined||state.headersReceived===true)throw relayError("protocol-error");
      state.headersReceived=true;state.fetchHeaders.resolve(decodeRelayFetchHeaders(frame.payload));return;
    }
    if (state.fetchHeaders!==undefined&&state.headersReceived!==true)throw relayError("protocol-error");
    if (frame.kind === RelayKind.DATA) {
      if (state.readClosed || frame.payload.byteLength > state.receiveCredit || this.#receivedBytes + frame.payload.byteLength > RELAY_BUFFER_LIMIT || (state.peer.transport === "udp" && frame.payload.byteLength > 4096)) throw relayError("protocol-error");
      state.receiveCredit -= frame.payload.byteLength;
      // The peer can have sent these bytes before it receives our read shutdown.
      if (state.readShutdown) return;
      this.#receivedBytes += frame.payload.byteLength;
      state.received.push(frame.payload);
      for (const reader of state.readers.splice(0)) reader.resolve();
    } else if (frame.kind === RelayKind.WINDOW) {
      if (state.sendCredit + frame.window > RELAY_MAX_CREDIT || [...this.#streams.values()].reduce((total,stream)=>total+stream.sendCredit,frame.window)>RELAY_BUFFER_LIMIT) throw relayError("protocol-error");
      state.sendCredit += frame.window; this.#flushWriters(frame.stream, state);
    } else if (frame.kind === RelayKind.HALF_CLOSE) {
      if (frame.payload[0] !== 0) { state.readClosed = true; for (const reader of state.readers.splice(0)) reader.resolve(); }
      if (frame.payload[0] !== 1) { state.writeClosed = true; this.#rejectWriters(state, relayError("disconnected")); }
    } else throw relayError("protocol-error");
  }
  #rejectWriters(state: StreamState, error: Error): void {
    for (const writer of state.writers.splice(0)) { this.#pendingBytes -= writer.bytes.byteLength; writer.reject(error); }
  }
  #removeStream(stream: bigint, state: StreamState, error: Error): void {
    state.opening.reject(error);
    for (const reader of state.readers.splice(0)) reader.reject(error);
    this.#rejectWriters(state, error);
    this.#receivedBytes -= state.received.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    this.#streams.delete(stream); this.#closedStreams.set(stream, { incoming: state.incoming, barrier: undefined });
    this.#requestRetirement();
  }
  #requestRetirement(): void {
    if (this.#closed || this.#retirementQueued) return;
    this.#retirementQueued = true;
    queueMicrotask(() => {
      this.#retirementQueued = false;
      if (this.#closed) return;
      const sequence = this.#ping++;
      for (const closed of this.#closedStreams.values()) if (closed.barrier === undefined) closed.barrier = sequence;
      // Outbound FIFO puts RESET before PING. Its PONG follows all in-flight stream frames.
      this.#send(RelayKind.PING, 0n, sequence, EMPTY, 0);
    });
  }
  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true; clearInterval(this.#heartbeat); clearTimeout(this.#drainTimer);
    const failure=error instanceof Error ? error : relayError("protocol-error");
    for (const [stream, state] of this.#streams) this.#removeStream(stream, state, failure);
    this.#outbound.length = 0; this.#queuedBytes = 0;
    this.#socket.onmessage = null; this.#socket.onclose = null; this.#socket.onerror = null;
    this.#socket.close(error instanceof VMError && error.code === "PROTOCOL_ERROR" ? 1002 : 1000);
    this.#onClose(relayFailure(error));
  }
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "Relay operation cancelled");
}
