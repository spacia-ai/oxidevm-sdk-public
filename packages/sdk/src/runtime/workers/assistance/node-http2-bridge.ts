import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import type { createNativeChildren, PipedChildHandle } from "./node-children.js";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { streamError } from "./node-streams.js";
import { http2GuestArguments } from "./node-http2-guest.js";
import { HTTP2_SERVICE_PROTOCOL_VERSION, decodeHttp2Event, http2Failure, http2Id, type Http2Event, type Http2Headers, type Http2Settings } from "./node-http2-wire.js";

type Target = { readonly session: number; readonly stream: number };
export type Http2Command =
  | { readonly kind: "server-close" }
  | { readonly kind: "server-timeout"; readonly duration: number }
  | ({ readonly kind: "request"; readonly headers: Http2Headers; readonly options: Readonly<Record<string, boolean>> } & Target)
  | ({ readonly kind: "read" } & Target)
  | ({ readonly kind: "stream-close"; readonly code: number } & Target)
  | ({ readonly kind: "stream-timeout"; readonly duration: number } & Target)
  | { readonly kind: "session-close"; readonly session: number }
  | { readonly kind: "session-destroy"; readonly session: number; readonly code: number }
  | { readonly kind: "session-timeout"; readonly session: number; readonly duration: number }
  | { readonly kind: "goaway"; readonly session: number; readonly code: number; readonly lastStreamID: number; readonly data: string };
export type Http2Call =
  | ({ readonly kind: "respond"; readonly headers: Http2Headers; readonly options: Readonly<Record<string, boolean>> } & Target)
  | ({ readonly kind: "trailers" | "additional-headers"; readonly headers: Http2Headers } & Target)
  | ({ readonly kind: "end" } & Target)
  | { readonly kind: "settings"; readonly session: number; readonly settings: Http2Settings }
  | { readonly kind: "ping"; readonly session: number; readonly data: string };
export type Http2Ack = Extract<Http2Event, { readonly kind: "reply" | "settings-ack" | "ping-ack" }>;
interface Pending { readonly kind: Http2Ack["kind"]; resolve(value: Http2Ack): void; reject(error: Error): void }
export type Http2Children = Pick<ReturnType<typeof createNativeChildren>, "spawnService">;

/** One helper owns one client or server. Requests are bounded, never replayed,
 * and retired with that helper. Rust owns its process and all descriptors. */
export class Http2Bridge {
  readonly #child: PipedChildHandle;
  readonly #pending = new Map<number, Pending>();
  #sequence = 0;
  #done = false;
  #failed: Error | undefined;
  constructor(children: Http2Children, configuration: Readonly<Record<string, unknown>>,
    readonly callbacks: { event(event: Http2Event): void; data(session: number, stream: number, bytes: Buffer): void; retired(error?: Error): void },
    readonly scheduler?: ProcessScheduler,
  ) {
    const initial = Buffer.from(JSON.stringify({ version: HTTP2_SERVICE_PROTOCOL_VERSION, ...configuration }));
    if (initial.length > 65536) throw new VMError("QUOTA_EXCEEDED", "HTTP/2 initialization exceeds its 64 KiB limit");
    this.#child = children.spawnService("/usr/bin/node", http2GuestArguments());
    this.#child.on("error", error => this.#fail(streamError(error)));
    this.#child.stdin.on("error", error => this.#fail(streamError(error)));
    const control = this.#control().catch((error: unknown) => this.#fail(streamError(error)));
    const data = this.#data().catch((error: unknown) => this.#fail(streamError(error)));
    this.#child.on("close", (code, signal) => {
      void Promise.all([control, data]).then(() => {
        if (!this.#done || code !== 0 || signal !== null) this.#fail(this.#failed ?? http2Failure("ERR_HTTP2_BRIDGE_EXIT", "Native HTTP/2 service exited before completion"));
        this.#dispatch(() => callbacks.retired(this.#failed));
      });
    });
    void this.#send(encodeNativeFrame(0, initial)).catch((error: unknown) => this.#fail(streamError(error)));
  }
  send(command: Http2Command): void {
    if (this.#failed !== undefined || this.#done) return;
    void this.#send(encodeNativeFrame(1, Buffer.from(JSON.stringify(command)))).catch((error: unknown) => this.#fail(streamError(error)));
  }
  call(command: Http2Call): Promise<Http2Ack> {
    return this.#request(command.kind === "settings" ? "settings-ack" : command.kind === "ping" ? "ping-ack" : "reply", request =>
      encodeNativeFrame(1, Buffer.from(JSON.stringify({ ...command, request }))));
  }
  async write(session: number, stream: number, value: Uint8Array): Promise<void> {
    for (let offset = 0; offset < value.length; offset += 65524) {
      const bytes = value.subarray(offset, offset + 65524);
      await this.#request("reply", request => {
        const payload = Buffer.allocUnsafe(12 + bytes.length); payload.writeUInt32BE(session, 0); payload.writeUInt32BE(stream, 4); payload.writeUInt32BE(request, 8); payload.set(bytes, 12);
        return encodeNativeFrame(0, payload);
      });
    }
  }
  #request(kind: Http2Ack["kind"], frame: (request: number) => Buffer): Promise<Http2Ack> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#done) return Promise.reject(http2Failure("ERR_HTTP2_INVALID_SESSION", "HTTP/2 service is closed"));
    if (this.#pending.size >= 256 || this.#sequence === 0x7fff_ffff) return Promise.reject(new VMError("QUOTA_EXCEEDED", "HTTP/2 request capacity exhausted"));
    const request = ++this.#sequence, completion = Promise.withResolvers<Http2Ack>();
    this.#pending.set(request, { kind, resolve: completion.resolve, reject: completion.reject });
    try { void this.#send(frame(request)).catch((error: unknown) => this.#fail(streamError(error))); }
    catch (error) { this.#pending.delete(request); completion.reject(streamError(error)); }
    return completion.promise;
  }
  #send(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => { this.#child.stdin.write(bytes, error => error ? reject(error) : resolve()); });
  }
  #dispatch(callback: () => void): void { if (this.scheduler === undefined) queueMicrotask(callback); else this.scheduler.enqueue(callback); }
  async #control(): Promise<void> {
    for (;;) {
      const frame = await readNativeFrame(this.#child.stderr);
      if (frame === null) { if (!this.#done && this.#failed === undefined) throw http2Failure("ERR_HTTP2_BRIDGE_EOF", "HTTP/2 control channel ended unexpectedly"); return; }
      if (frame.tag !== 1) throw new VMError("PROTOCOL_ERROR", "HTTP/2 data appeared on its control channel");
      const event = decodeHttp2Event(frame.bytes);
      if (event.kind === "fatal") { this.#fail(http2Failure(event.code, event.message)); continue; }
      if (event.kind === "done") {
        if (this.#done || this.#pending.size !== 0) throw new VMError("PROTOCOL_ERROR", "HTTP/2 service ended with pending requests");
        this.#done = true; continue;
      }
      if (event.kind === "reply" || event.kind === "settings-ack" || event.kind === "ping-ack") {
        const pending = this.#pending.get(event.request);
        if (pending === undefined || pending.kind !== event.kind) throw new VMError("PROTOCOL_ERROR", "Unmatched native HTTP/2 completion");
        this.#pending.delete(event.request);
        if (event.error === null) pending.resolve(event); else pending.reject(http2Failure(event.error.code, event.error.message));
      } else this.#dispatch(() => this.callbacks.event(event));
    }
  }
  async #data(): Promise<void> {
    for (;;) {
      const frame = await readNativeFrame(this.#child.stdout); if (frame === null) return;
      if (frame.tag !== 0 || frame.bytes.length <= 8) throw new VMError("PROTOCOL_ERROR", "Invalid HTTP/2 body frame");
      const session = http2Id(frame.bytes.readUInt32BE(0)), stream = http2Id(frame.bytes.readUInt32BE(4));
      const bytes = Buffer.from(frame.bytes.subarray(8)); this.#dispatch(() => this.callbacks.data(session, stream, bytes));
    }
  }
  #fail(error: Error): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear(); this.#child.kill("SIGKILL");
  }
}
