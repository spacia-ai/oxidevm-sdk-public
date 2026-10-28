import { Buffer } from "buffer";
import { VMError } from "../../errors.js";

export type HttpRequestHead = {
  readonly method: string; readonly url: string;
  readonly major: number; readonly minor: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly keepAlive: boolean; readonly upgrade: boolean;
};
export type HttpResponseHead = {
  readonly statusCode: number; readonly statusMessage: string;
  readonly major: number; readonly minor: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly keepAlive: boolean; readonly upgrade: boolean;
};
type Callbacks = ({ readonly kind: "request"; headers(head: HttpRequestHead): void }
  | { readonly kind: "response"; headers(head: HttpResponseHead): "body" | "skip-body" | "upgrade" }) & {
  body(bytes: Uint8Array<ArrayBuffer>): boolean;
  complete(trailers: readonly (readonly [string, string])[]): boolean;
};
type ParseResult = { readonly consumed: number; readonly state: "ready" | "paused" | "upgrade" };
const CAPACITY = 65536;
const PAUSED = 21;
const UPGRADE = 22;
const WasmInstance = WebAssembly.Instance;
const WasmMemory = WebAssembly.Memory;

/** One bounded parser instance per connection, instantiated from a verified,
 * broker-compiled llhttp module. Application workers never compile or fetch it. */
export class HttpParser {
  readonly #exports: WebAssembly.Exports;
  readonly #memory: WebAssembly.Memory;
  readonly #parser: number;
  readonly #buffer: number;
  readonly #callbacks: Callbacks;
  #closed = false;
  #inMessage = false;
  #executing = false;
  #paused = false;
  #upgraded = false;
  #url = "";
  #status = "";
  #headers: [string, string][] = [];
  #field = "";
  #value = "";
  #hasValue = false;
  #headerBytes = 0;

  constructor(module: WebAssembly.Module, callbacks: Callbacks) {
    this.#callbacks = callbacks;
    const instance = new WasmInstance(module, { env: {
      wasm_on_message_begin: () => { this.#inMessage = true; this.#url = ""; this.#status = ""; this.#headers = []; this.#field = ""; this.#value = ""; this.#hasValue = false; this.#headerBytes = 0; return 0; },
      wasm_on_url: (_parser: number, at: number, length: number) => {
        this.#url += this.#text(at, length);
        if (this.#url.length > 8192) throw parseError("HPE_HEADER_OVERFLOW", "HTTP request target exceeds its bound");
        return 0;
      },
      wasm_on_status: (_parser: number, at: number, length: number) => {
        this.#status += this.#headerText(at, length); return 0;
      },
      wasm_on_header_field: (_parser: number, at: number, length: number) => {
        if (this.#hasValue) this.#flushHeader();
        this.#field += this.#headerText(at, length); return 0;
      },
      wasm_on_header_value: (_parser: number, at: number, length: number) => {
        this.#hasValue = true; this.#value += this.#headerText(at, length); return 0;
      },
      wasm_on_headers_complete: (parser: number, statusCode: number, upgrade: number, keepAlive: number) => {
        this.#flushHeader();
        const headers = this.#headers; this.#headers = [];
        const common = { major: this.#number("llhttp_get_http_major", parser), minor: this.#number("llhttp_get_http_minor", parser),
          headers, keepAlive: keepAlive === 1, upgrade: upgrade === 1 };
        if (this.#callbacks.kind === "request") {
          this.#callbacks.headers({ ...common, method: this.#cstring(this.#number("llhttp_method_name", this.#number("llhttp_get_method", parser))), url: this.#url });
          return 0;
        }
        if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) throw parseError("HPE_INVALID_STATUS", "Invalid HTTP response status");
        const action = this.#callbacks.headers({ ...common, statusCode, statusMessage: this.#status });
        return action === "skip-body" ? 1 : action === "upgrade" ? 2 : 0;
      },
      wasm_on_body: (_parser: number, at: number, length: number) => this.#callbacks.body(this.#bytes(at, length).slice()) ? 0 : PAUSED,
      wasm_on_message_complete: () => {
        this.#flushHeader();
        const trailers = this.#headers; this.#headers = [];
        this.#inMessage = false;
        return this.#callbacks.complete(trailers) ? 0 : PAUSED;
      },
    } });
    this.#exports = instance.exports;
    const memory = instance.exports["memory"];
    if (!(memory instanceof WasmMemory)) throw new VMError("PROTOCOL_ERROR", "llhttp memory export missing");
    this.#memory = memory;
    this.#parser = this.#number("llhttp_alloc", callbacks.kind === "request" ? 1 : 2);
    if (this.#parser === 0) throw new VMError("QUOTA_EXCEEDED", "llhttp parser allocation failed");
    try {
      this.#buffer = this.#number("malloc", CAPACITY);
      if (this.#buffer === 0) throw new VMError("QUOTA_EXCEEDED", "llhttp input allocation failed");
      this.#bytes(this.#buffer, CAPACITY);
    } catch (error) { this.#invoke("llhttp_free", this.#parser); throw error; }
  }

  get inMessage(): boolean { return this.#inMessage; }

  feed(bytes: Uint8Array): ParseResult {
    this.#active();
    if (this.#paused || this.#upgraded) throw new VMError("PROTOCOL_ERROR", "HTTP parser is paused or upgraded");
    if (bytes.length > CAPACITY) throw new VMError("QUOTA_EXCEEDED", "HTTP input chunk exceeds its bound");
    this.#bytes(this.#buffer, bytes.length).set(bytes);
    this.#executing = true;
    try {
      const result = this.#number("llhttp_execute", this.#parser, this.#buffer, bytes.length);
      if (result === 0) return { consumed: bytes.length, state: "ready" };
      if (result === PAUSED || result === UPGRADE) {
        const consumed = this.#number("llhttp_get_error_pos", this.#parser) - this.#buffer;
        if (consumed < 0 || consumed > bytes.length) throw new VMError("PROTOCOL_ERROR", "Invalid llhttp input position");
        this.#paused = result === PAUSED; this.#upgraded = result === UPGRADE;
        return { consumed, state: this.#paused ? "paused" : "upgrade" };
      }
      throw parseError(this.#cstring(this.#number("llhttp_errno_name", result)), "Invalid HTTP message framing");
    } catch (error) {
      this.#executing = false; this.close(); throw error;
    } finally { this.#executing = false; }
  }

  resume(): void {
    this.#active();
    if (!this.#paused || this.#upgraded) throw new VMError("PROTOCOL_ERROR", "HTTP parser is not resumable");
    this.#invoke("llhttp_resume", this.#parser); this.#paused = false;
  }

  finish(): void {
    this.#active();
    this.#executing = true;
    try {
      const result = this.#number("llhttp_finish", this.#parser);
      if (result !== 0) throw parseError(this.#cstring(this.#number("llhttp_errno_name", result)), "Incomplete HTTP message");
    } catch (error) {
      this.#executing = false; this.close(); throw error;
    } finally { this.#executing = false; }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#executing) throw new VMError("PROTOCOL_ERROR", "Cannot retire llhttp during a callback");
    this.#closed = true;
    this.#invoke("free", this.#buffer); this.#invoke("llhttp_free", this.#parser);
  }

  #active(): void {
    if (this.#closed || this.#executing) throw new VMError("PROTOCOL_ERROR", "HTTP parser retired or reentered");
  }
  #flushHeader(): void {
    if (this.#field.length !== 0) {
      if (this.#headers.length >= 128) throw parseError("HPE_HEADER_OVERFLOW", "Too many HTTP headers");
      this.#headers.push([this.#field, this.#value]);
    }
    this.#field = ""; this.#value = ""; this.#hasValue = false;
  }
  #headerText(at: number, length: number): string {
    this.#headerBytes += length;
    if (this.#headerBytes > CAPACITY) throw parseError("HPE_HEADER_OVERFLOW", "HTTP headers exceed their bound");
    return this.#text(at, length);
  }
  #text(at: number, length: number): string { return Buffer.from(this.#bytes(at, length)).toString("latin1"); }
  #bytes(at: number, length: number): Uint8Array<ArrayBuffer> {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > this.#memory.buffer.byteLength) {
      throw new VMError("PROTOCOL_ERROR", "Invalid llhttp memory span");
    }
    return new Uint8Array(this.#memory.buffer, at, length);
  }
  #cstring(at: number): string {
    const bytes = this.#bytes(at, Math.min(128, this.#memory.buffer.byteLength - at));
    const end = bytes.indexOf(0);
    if (end < 0) throw new VMError("PROTOCOL_ERROR", "Invalid llhttp symbol");
    return Buffer.from(bytes.subarray(0, end)).toString("ascii");
  }
  #invoke(name: string, ...args: number[]): unknown {
    const operation: unknown = this.#exports[name];
    if (typeof operation !== "function") throw new VMError("PROTOCOL_ERROR", `Missing llhttp export ${name}`);
    const result: unknown = Reflect.apply(operation, undefined, args);
    return result;
  }
  #number(name: string, ...args: number[]): number {
    const result = this.#invoke(name, ...args);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new VMError("PROTOCOL_ERROR", `Invalid llhttp result ${name}`);
    return result;
  }
}
export class HttpParseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function parseError(code: string, message: string): Error { return new HttpParseError(code, message); }
