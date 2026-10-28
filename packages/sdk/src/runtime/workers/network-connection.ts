import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { NetworkState, RelayFailureReason } from "../network-types.js";
import { decodeRelayFailure, relayError, relayFailure } from "../relay-errors.js";
import { boundedText, decodeRelayOptions, type RelayOptions, type NetworkView } from "../protocol/network.js";
import { RelayConnection } from "./relay-protocol.js";
import { decodeRelayTicket, type RelayIdentity, type RelayTicket } from "./relay-wire.js";

const PERSONAL = new URL("http://127.0.0.1:7337/");
/** Both real runtime adapters implement the same enable/revoke boundary. */
export interface RelayRuntimeAdapter { setRelay(connection: RelayConnection | undefined, generation: number): Promise<void> }
interface Session {
  readonly identity: RelayIdentity; readonly endpoint: URL; readonly generation: number;
  readonly pairing: {id:string;poll:string} | undefined;
  connection: RelayConnection | undefined;
}

export class RelayConnectionOwner {
  readonly #scope: {readonly origin:string;readonly workspaceId:string;readonly workspaceName?:string;readonly serverAllowed?:boolean};
  readonly #adapter: RelayRuntimeAdapter;
  #state: NetworkState = {kind:"off"};
  #revision = 0;
  #generation = 0;
  #session: Session | undefined;
  #attempt: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #disconnecting: Promise<void> | undefined;
  #releasing: Promise<void> | undefined;
  #adapterChanges = Promise.resolve();
  readonly #watchers = new Set<{after:number;resolve(view:NetworkView):void;reject(error:unknown):void}>();
  constructor(scope: {readonly origin:string;readonly workspaceId:string;readonly workspaceName?:string;readonly serverAllowed?:boolean}, adapter: RelayRuntimeAdapter) { this.#scope=scope; this.#adapter=adapter; }
  get state(): NetworkState { return this.#state; }
  get view(): NetworkView { return {revision:this.#revision,state:this.#state}; }
  get connection(): RelayConnection | undefined { return this.#session?.connection; }
  connect(input: RelayOptions, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new VMError("ABORTED","Relay connection cancelled"));
    if (this.#attempt !== undefined || this.#disconnecting !== undefined || this.#releasing !== undefined || this.#session !== undefined) return Promise.reject(new VMError("INVALID_ARGUMENT","Disconnect before changing relay"));
    const options = decodeRelayOptions(input, this.#scope.origin);
    if (options.kind === "server" && this.#scope.serverAllowed === false) return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "Server relay is disabled by this application"));
    const controller = new AbortController(); this.#abort = controller;
    const pending = this.#connect(options, AbortSignal.any([signal,controller.signal])); this.#attempt = pending;
    return pending.finally(() => { if (this.#attempt === pending) {this.#attempt=undefined;this.#abort=undefined;} });
  }
  disconnect(): Promise<void> {
    this.#disconnecting ??= this.#disconnect().finally(() => {this.#disconnecting=undefined;});
    return this.#disconnecting;
  }
  async #disconnect(): Promise<void> {
    this.#abort?.abort(); await this.#attempt?.catch(() => {});
    try { await this.#release(); } finally { this.#update({kind:"off"}); }
  }
  async wait(after: number, signal: AbortSignal): Promise<NetworkView> {
    if (signal.aborted) throw new VMError("ABORTED","Network watch cancelled");
    if (after < this.#revision) return this.view;
    if (after > this.#revision || this.#watchers.size >= 64) throw relayError("protocol-error");
    return new Promise((resolve,reject) => {
      const abort = () => {this.#watchers.delete(watcher);reject(new VMError("ABORTED","Network watch cancelled"));};
      const watcher = {after,resolve:(view:NetworkView) => {signal.removeEventListener("abort",abort);resolve(view);},reject};
      this.#watchers.add(watcher); signal.addEventListener("abort",abort,{once:true});
    });
  }
  async #connect(options: RelayOptions, signal: AbortSignal): Promise<void> {
    const identity = {workspaceId:this.#scope.workspaceId,browserSessionId:randomSessionId()};
    const endpoint = options.kind === "personal" ? PERSONAL : new URL(options.url);
    const generation = ++this.#generation;
    try {
      let ticket: RelayTicket;
      if (options.kind === "personal") {
        this.#update({kind:"discovering"});
        await discover(signal);
        const name = options.workspaceName ?? this.#scope.workspaceName ?? identity.workspaceId;
        const response = await jsonRequest(new URL("v2/pairings",endpoint),{method:"POST",body:JSON.stringify({version:2,...identity,workspaceName:boundedText(name,"workspace name",100)}),headers:{"content-type":"application/json"}},signal);
        const pending = record(response,"pairing");
        exactKeys(pending,["version","id","poll","code","origin","workspaceId","workspaceName","expiresAt"]);
        if (pending["version"] !== 2) throw relayError("version-mismatch");
        const id=string(pending["id"],"pairing ID"); const poll=string(pending["poll"],"poll credential");
        if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(poll) || pending["origin"] !== this.#scope.origin || pending["workspaceId"] !== identity.workspaceId || pending["workspaceName"] !== name || typeof pending["code"] !== "string" || !/^\d{6}$/.test(pending["code"])) throw relayError("protocol-error");
        const expiresAt = integer(pending["expiresAt"],"approval expiry",Date.now()+1,Date.now()+121000);
        this.#session = {identity,endpoint,generation,pairing:{id,poll},connection:undefined};
        this.#update({kind:"awaiting-approval",code:pending["code"],origin:this.#scope.origin,workspaceId:identity.workspaceId,workspaceName:name,expiresAt});
        ticket = await claim(endpoint,id,poll,expiresAt,signal);
      } else {
        this.#update({kind:"connecting",relay:"server"});
        this.#session = {identity,endpoint,generation,pairing:undefined,connection:undefined};
        const authUrl = options.sessionUrl === undefined ? new URL("v2/sessions",endpoint) : new URL(options.sessionUrl);
        const response = await jsonRequest(authUrl,{method:"POST",credentials:"include",headers:{...options.headers,"content-type":"application/json"},body:JSON.stringify({version:2,...identity,origin:this.#scope.origin})},signal,options.sessionUrl !== undefined);
        ticket = decodeRelayTicket(response,endpoint);
      }
      this.#update({kind:"connecting",relay:options.kind});
      const connection = await RelayConnection.connect(ticket, identity, signal, reason => {
        if (this.#session?.generation === generation) void this.#lost(reason).catch(() => { this.#update({kind:"failed",reason}); });
      });
      let session: Session;
      try { session = this.#activeSession(generation, signal); }
      catch (error: unknown) { connection.dispose(); throw error; }
      session.connection = connection;
      await this.#setAdapter(connection,generation);
      if (this.#activeSession(generation, signal) !== session) throw new VMError("ABORTED","Relay connection cancelled");
      this.#update({kind:"connected",relay:options.kind,expiresAt:connection.expiresAt});
    } catch (error) {
      await this.#release().catch(() => {});
      if (signal.aborted) {this.#update({kind:"off"});throw new VMError("ABORTED","Relay connection cancelled");}
      const reason = relayFailure(error); this.#update({kind:"failed",reason}); throw relayError(reason);
    }
  }
  #activeSession(generation: number, signal: AbortSignal): Session {
    const session = this.#session;
    if (session === undefined || session.generation !== generation || signal.aborted) throw new VMError("ABORTED", "Relay connection cancelled");
    return session;
  }
  #setAdapter(connection: RelayConnection | undefined, generation: number): Promise<void> {
    const pending = this.#adapterChanges.then(() => this.#adapter.setRelay(connection,generation));
    this.#adapterChanges = pending.catch(() => {});
    return pending;
  }
  #release(): Promise<void> {
    this.#releasing ??= this.#releaseSession().finally(() => { this.#releasing = undefined; });
    return this.#releasing;
  }
  async #releaseSession(): Promise<void> {
    const session = this.#session; this.#session=undefined;
    session?.connection?.dispose();
    try { await this.#setAdapter(undefined,++this.#generation); }
    finally { if (session !== undefined) {
      try {
        const url = session.pairing === undefined ? new URL("v2/revoke",session.endpoint) : new URL(`v2/pairings/${session.pairing.id}`,session.endpoint);
        await fetch(url,{method:session.pairing === undefined ? "POST" : "DELETE",credentials:session.pairing === undefined ? "include" : "omit",headers:session.pairing === undefined ? {"content-type":"application/json"} : {authorization:`Bearer ${session.pairing.poll}`},...(session.pairing === undefined ? {body:JSON.stringify(session.identity)} : {}),signal:AbortSignal.timeout(5000),redirect:"error",cache:"no-store"});
      } catch { /* Closing the authenticated WebSocket also revokes its native session. */ }
    } }
  }
  async #lost(reason: RelayFailureReason): Promise<void> {await this.#release();this.#update({kind:"failed",reason});}
  #update(state: NetworkState): void {
    this.#state=Object.freeze(state); this.#revision++;
    for (const watcher of this.#watchers) { if (watcher.after < this.#revision) {this.#watchers.delete(watcher);watcher.resolve(this.view);} }
  }
}
async function discover(signal: AbortSignal): Promise<void> {
  let value: unknown;
  try {value=await jsonRequest(new URL("v2/health",PERSONAL),{},signal);} catch (error) {
    if (error instanceof VMError) throw error;
    const reason = relayFailure(error);
    throw relayError(reason === "disconnected" ? "discovery-failed" : reason);
  }
  const health=record(value,"relay health"); exactKeys(health,["version","kind","capabilities"]);
  if (health["version"] !== 2) throw relayError("version-mismatch");
  const capabilities=health["capabilities"];
  if (health["kind"] !== "personal" || !Array.isArray(capabilities) || capabilities.length !== 3 || !["tcp","dns","https-get"].every(cap => capabilities.includes(cap))) throw relayError("protocol-error");
}
async function claim(endpoint: URL, id: string, poll: string, expiresAt: number, signal: AbortSignal): Promise<RelayTicket> {
  while (Date.now() < expiresAt) {
    const value=await jsonRequest(new URL(`v2/pairings/${id}/claim`,endpoint),{method:"POST",headers:{authorization:`Bearer ${poll}`}},signal);
    const data=record(value,"pairing claim");
    if (data["kind"] !== "pending") return decodeRelayTicket(value,endpoint);
    exactKeys(data,["version","kind"]); if (data["version"] !== 2) throw relayError("version-mismatch");
    await new Promise<void>((resolve,reject) => {
      const abort=() => {clearTimeout(timer);reject(new VMError("ABORTED","Pairing cancelled"));};
      const timer=setTimeout(() => {signal.removeEventListener("abort",abort);resolve();},500);
      signal.addEventListener("abort",abort,{once:true}); if(signal.aborted) abort();
    });
  }
  throw relayError("approval-expired");
}
async function jsonRequest(url: URL, options: RequestInit, signal: AbortSignal, applicationAuthorization = false): Promise<unknown> {
  const response=await fetch(url,{credentials:"omit",...options,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),redirect:"error",cache:"no-store"});
  if (applicationAuthorization && (response.status === 401 || response.status === 403)) {
    await response.body?.cancel();
    throw relayError("authentication-failed");
  }
  if (response.body === null) throw relayError("protocol-error");
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let length=0;
  try {
    for(let read=await reader.read();!read.done;read=await reader.read()){length+=read.value.byteLength;if(length>8192)throw relayError("protocol-error");chunks.push(read.value);}
  } finally {await reader.cancel().catch(() => {});reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let value:unknown;
  try { value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw relayError("protocol-error"); }
  if(!response.ok){ const data=record(value,"relay failure");exactKeys(data,["version","reason"]);if(data["version"]!==2)throw relayError("version-mismatch");throw relayError(decodeRelayFailure(data["reason"])); }
  return value;
}
function randomSessionId(): string {const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");}
