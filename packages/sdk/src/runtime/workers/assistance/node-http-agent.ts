import { TLS_OPTION_NAMES, tlsOptions, type TlsOptions } from "./node-tls.js";
import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";
import type { NodeSocket, NodeSockets } from "./node-socket.js";
import { EventEmitter, bindAsyncEvents, streamError } from "./node-streams.js";

type Origin = { readonly host: string; readonly port: number } & TlsOptions;
type Request = { readonly destroyed: boolean; reusedSocket: boolean; onSocket(socket?: NodeSocket, error?: Error): void };
type Pending = { readonly request: Request; readonly origin: Origin; readonly key: string };
type Entry = { readonly key: string; state: "busy" | "free" | "handoff"; readonly detach: () => void };
export type HttpAgent = EventEmitter & {
  readonly protocol: string; readonly defaultPort: number; readonly options: Record<string, unknown>;
  keepAlive: boolean; keepAliveMsecs: number; maxSockets: number; maxTotalSockets: number; maxFreeSockets: number; scheduling: "fifo" | "lifo";
  readonly totalSocketCount: number; readonly sockets: Record<string, NodeSocket[]>; readonly freeSockets: Record<string, NodeSocket[]>; readonly requests: Record<string, Request[]>;
  getName(options: Origin): string;
  createConnection(options: Origin): NodeSocket;
  addRequest(request: Request, origin: Origin): void;
  cancelRequest(request: Request): void;
  keepSocketAlive(socket: NodeSocket): boolean;
  reuseSocket(socket: NodeSocket, request: Request): void;
  removeSocket(socket: NodeSocket): void;
  destroy(): void;
};
const SOCKET_LIMIT = 128;
const REQUEST_LIMIT = 1024;

/** The agent alone owns busy/free sockets and pending requests. Inspection
 * properties are snapshots of that registry, never a second mutable authority. */
export function createHttpAgents(net: Pick<NodeSockets, "createConnection">, context: AsyncContext, dispatch: (callback: () => void) => void = queueMicrotask, protocol: "http:" | "https:" = "http:"): { Agent: new (options?: unknown) => HttpAgent; globalAgent: HttpAgent } {
  class Agent extends EventEmitter {
    readonly protocol = protocol;
    readonly defaultPort = protocol === "https:" ? 443 : 80;
    readonly options: Record<string, unknown>;
    keepAlive: boolean;
    keepAliveMsecs: number;
    maxSockets: number;
    maxTotalSockets: number;
    maxFreeSockets: number;
    scheduling: "fifo" | "lifo";
    readonly #sockets = new Map<NodeSocket, Entry>();
    readonly #pending: Pending[] = [];
    #draining = false;
    constructor(value: unknown = {}) {
      super(); const options = record(value, "http.Agent options");
      exactKeys(options, [], ["keepAlive", "keepAliveMsecs", "maxSockets", "maxTotalSockets", "maxFreeSockets", "scheduling", "timeout", "noDelay", ...(protocol === "https:" ? TLS_OPTION_NAMES : [])]);
      if (options["keepAlive"] !== undefined && typeof options["keepAlive"] !== "boolean") throw new TypeError("Invalid Agent keepAlive");
      if (options["scheduling"] !== undefined && options["scheduling"] !== "fifo" && options["scheduling"] !== "lifo") throw new TypeError("Invalid Agent scheduling");
      if (options["noDelay"] !== undefined && typeof options["noDelay"] !== "boolean") throw new TypeError("Invalid Agent noDelay");
      this.options = { ...options, ...(protocol === "https:" ? tlsOptions(options) : {}) }; Object.setPrototypeOf(this.options, null);
      this.keepAlive = options["keepAlive"] === true;
      this.keepAliveMsecs = count(options["keepAliveMsecs"] ?? 1000, 0);
      this.maxSockets = count(options["maxSockets"] ?? Infinity, 1);
      this.maxTotalSockets = count(options["maxTotalSockets"] ?? Infinity, 1);
      this.maxFreeSockets = count(options["maxFreeSockets"] ?? 256, 0);
      this.scheduling = options["scheduling"] === "fifo" ? "fifo" : "lifo";
      if (options["timeout"] !== undefined) count(options["timeout"], 0);
      bindAsyncEvents(this, context);
    }
    get totalSocketCount(): number { return this.#sockets.size; }
    get sockets(): Record<string, NodeSocket[]> { return this.#snapshot(false); }
    get freeSockets(): Record<string, NodeSocket[]> { return this.#snapshot(true); }
    get requests(): Record<string, Request[]> {
      const result: Record<string, Request[]> = {}; Object.setPrototypeOf(result, null);
      for (const pending of this.#pending) (result[pending.key] ??= []).push(pending.request);
      return result;
    }
    getName(options: Origin): string {
      const base = `${options.host}:${options.port}:`;
      return protocol === "https:" ? `${base}${JSON.stringify(tlsOptions(options))}` : base;
    }
    createConnection(options: Origin): NodeSocket {
      const socket = net.createConnection({ host: options.host, port: options.port, ...(protocol === "https:" ? tlsOptions(options) : {}) });
      if (this.options["noDelay"] !== false) socket.setNoDelay();
      return socket;
    }
    addRequest(request: Request, origin: Origin): void {
      if (this.#pending.length >= REQUEST_LIMIT) throw new VMError("QUOTA_EXCEEDED", "HTTP agent pending request limit exceeded");
      if (protocol === "https:") {
        const tls = tlsOptions({ ...this.options, ...origin });
        origin = { host: origin.host, port: origin.port, ...tls, servername: tls.servername ?? (/^[0-9.]+$/u.test(origin.host) || origin.host.includes(":") ? "" : origin.host) };
      }
      this.#pending.push({ request, origin, key: this.getName(origin) }); this.#drain();
    }
    cancelRequest(request: Request): void {
      const index = this.#pending.findIndex(item => item.request === request);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#drain();
    }
    keepSocketAlive(socket: NodeSocket): boolean {
      socket.setKeepAlive(true, this.keepAliveMsecs); socket.unref();
      socket.setTimeout(this.options["timeout"] ?? 0); return true;
    }
    reuseSocket(socket: NodeSocket, request: Request): void { socket.ref(); socket.setTimeout(0); request.reusedSocket = true; }
    removeSocket(socket: NodeSocket): void {
      const entry = this.#sockets.get(socket);
      if (entry === undefined) return;
      entry.detach(); this.#sockets.delete(socket); this.#drain();
    }
    destroy(): void {
      const pending = this.#pending.splice(0);
      for (const [socket, entry] of this.#sockets) { entry.detach(); socket.destroy(); }
      this.#sockets.clear();
      for (const item of pending) dispatch(() => item.request.onSocket(undefined, reset("HTTP agent destroyed")));
    }
    #snapshot(free: boolean): Record<string, NodeSocket[]> {
      const result: Record<string, NodeSocket[]> = {}; Object.setPrototypeOf(result, null);
      for (const [socket, entry] of this.#sockets) if ((entry.state === "free") === free) (result[entry.key] ??= []).push(socket);
      return result;
    }
    #drain(): void {
      if (this.#draining) return;
      this.#draining = true;
      try {
        for (let index = 0; index < this.#pending.length;) {
          const item = this.#pending[index]; if (item === undefined) break;
          if (item.request.destroyed) {
            this.#pending.splice(index, 1); dispatch(() => item.request.onSocket(undefined, reset("HTTP request cancelled"))); continue;
          }
          const free = [...this.#sockets].filter(([socket, entry]) => entry.state !== "busy" && entry.key === item.key && !socket.destroyed);
          const found = this.scheduling === "fifo" ? free[0] : free.at(-1);
          let socket = found?.[0];
          if (found !== undefined && socket !== undefined) {
            const idle = found[1].state === "free"; found[1].state = "busy";
            this.reuseSocket(socket, item.request); item.request.reusedSocket = idle;
          }
          else {
            const originCount = [...this.#sockets.values()].filter(entry => entry.key === item.key).length;
            if (originCount >= this.maxSockets || this.#sockets.size >= this.maxTotalSockets) { index++; continue; }
            if (this.#sockets.size >= SOCKET_LIMIT) {
              this.#pending.splice(index, 1); dispatch(() => item.request.onSocket(undefined, new VMError("QUOTA_EXCEEDED", "HTTP agent socket limit exceeded"))); continue;
            }
            try { socket = this.createConnection(item.origin); this.#own(socket, item); }
            catch (error) { this.#pending.splice(index, 1); dispatch(() => item.request.onSocket(undefined, streamError(error))); continue; }
          }
          this.#pending.splice(index, 1); const assigned = socket;
          dispatch(() => {
            if (item.request.destroyed) { assigned.emit("free"); item.request.onSocket(undefined, reset("HTTP request cancelled")); }
            else if (assigned.destroyed) item.request.onSocket(undefined, reset("HTTP socket closed before assignment"));
            else item.request.onSocket(assigned);
          });
        }
      } finally { this.#draining = false; }
    }
    #own(socket: NodeSocket, item: Pending): void {
      const free = () => {
        const entry = this.#sockets.get(socket); if (entry === undefined || entry.state !== "busy") return;
        if (socket.destroyed || socket.writableEnded || socket.readableEnded) { socket.destroy(); return; }
        const waiting = this.#pending.some(pending => pending.key === entry.key && !pending.request.destroyed);
        const freeCount = [...this.#sockets.values()].filter(value => value.state === "free" && value.key === entry.key).length;
        try {
          if (!waiting && (!this.keepAlive || freeCount >= this.maxFreeSockets || !this.keepSocketAlive(socket))) { socket.destroy(); return; }
          entry.state = waiting ? "handoff" : "free"; this.#sockets.delete(socket); this.#sockets.set(socket, entry); this.#drain();
        } catch { socket.destroy(); }
      };
      const close = () => this.removeSocket(socket);
      const error = () => { if (this.#sockets.get(socket)?.state === "free") socket.destroy(); };
      const timeout = () => { if (this.#sockets.get(socket)?.state === "free") socket.destroy(); };
      const remove = () => this.removeSocket(socket);
      const detach = () => {
        socket.removeListener("free", free); socket.removeListener("close", close); socket.removeListener("error", error);
        socket.removeListener("timeout", timeout); socket.removeListener("agentRemove", remove);
      };
      this.#sockets.set(socket, { key: item.key, state: "busy", detach });
      socket.on("free", free); socket.once("close", close); socket.on("error", error); socket.on("timeout", timeout); socket.once("agentRemove", remove);
    }
  }
  return { Agent, globalAgent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 }) };
}
function count(value: unknown, minimum: number): number {
  if (typeof value !== "number" || value < minimum || (value !== Infinity && !Number.isSafeInteger(value))) throw new TypeError("Invalid HTTP agent numeric option");
  return value;
}
function reset(message: string): Error { return Object.assign(new Error(message), { code: "ECONNRESET" }); }
