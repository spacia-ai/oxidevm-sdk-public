// The router module (ADR 0015) as the network worker drives it: fetched and compiled with no
// imports, its exports checked, and every call made through one place that turns a trap into
// RELAY_ERROR and views the module's memory afresh, because any call may grow it.
import { VMError } from "../../errors.js";
import {
  decodeRouterConnectionStatus,
  decodeRouterEgressEvent,
  decodeRouterEgressStatus,
  type RouterEgressEvent,
  NETSTACK_API_VERSION,
  NETSTACK_BUFFER_BYTES,
  NETSTACK_EXPORTS,
  type NetstackExport,
  type RouterConnectionStatus,
  validateNetstackExports,
} from "../../netstack-abi.js";

/** The raw ABI's answer for an argument the router cannot take, and for "no deadline". */
const INVALID = 0xffff_ffff;

export type RouterOpen = { readonly kind: "opening"; readonly id: number } | { readonly kind: "busy" };

/** The router as connections use it: the Wasm module, or a scripted router in tests. */
export interface NetstackRouterApi {
  /** Starts the router over for a replaced machine; counters and connection ids carry on. */
  init(seed: bigint, nowMilliseconds: number): void;
  framesIn(records: Uint8Array): number;
  framesOut(maximumBytes: number): Uint8Array<ArrayBuffer>;
  /** Milliseconds until the router next needs a poll; undefined when nothing is pending. */
  poll(nowMilliseconds: number): number | undefined;
  open(port: number): RouterOpen;
  status(id: number): RouterConnectionStatus;
  send(id: number, bytes: Uint8Array): number;
  receive(id: number, maximumBytes: number): Uint8Array<ArrayBuffer>;
  close(id: number): void;
  counters(): Uint8Array<ArrayBuffer>;
  setNetwork(generation: number, enabled: boolean): void;
  egressNext(): RouterEgressEvent | undefined;
  egressComplete(generation: number, id: number, kind: 1 | 2 | 3 | 4 | 5, bytes?: Uint8Array): boolean;
  egressStatus(generation: number, id: number): number;
  egressSend(generation: number, id: number, bytes: Uint8Array): number;
  egressReceive(generation: number, id: number, maximum: number): Uint8Array<ArrayBuffer>;
}

export type NetstackLoader = (url: string, seed: bigint, nowMilliseconds: number) => Promise<NetstackRouterApi>;

export class NetstackRouter implements NetstackRouterApi {
  readonly #exports: Readonly<Record<string, unknown>>;
  readonly #memory: WebAssembly.Memory;
  readonly #buffer: number;

  private constructor(exports: Readonly<Record<string, unknown>>, memory: WebAssembly.Memory, buffer: number) {
    this.#exports = exports;
    this.#memory = memory;
    this.#buffer = buffer;
  }

  static async load(url: string, seed: bigint, nowMilliseconds: number): Promise<NetstackRouter> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw loadError("fetch", "the router module could not be fetched");
    }
    if (!response.ok) throw loadError("fetch", `the router module answered HTTP ${String(response.status)}`);
    let module: WebAssembly.Module;
    try {
      module = await WebAssembly.compile(await response.arrayBuffer());
    } catch {
      throw loadError("compile", "the router module does not compile");
    }
    if (WebAssembly.Module.imports(module).length > 0) throw loadError("exports", "the router module must not import anything");
    validateNetstackExports(WebAssembly.Module.exports(module));
    const instance = await WebAssembly.instantiate(module, {});
    return NetstackRouter.fromExports(instance.exports, seed, nowMilliseconds);
  }

  /** Wraps an instance's exports and starts the router: the ABI version, the buffer and `init`
   * must all check out. */
  static fromExports(exports: Readonly<Record<string, unknown>>, seed: bigint, nowMilliseconds: number): NetstackRouter {
    for (const name of NETSTACK_EXPORTS) {
      if (typeof exports[name] !== "function") throw loadError("exports", `the router module does not export ${name}`);
    }
    const memory = exports["memory"];
    if (!(memory instanceof WebAssembly.Memory)) throw loadError("exports", "the router module does not export its memory");
    const probe = new NetstackRouter(exports, memory, 0);
    if (probe.#call("oxidevm_netstack_api_version") !== NETSTACK_API_VERSION
      || probe.#call("oxidevm_netstack_buffer_capacity") !== NETSTACK_BUFFER_BYTES) {
      throw loadError("version", "the router module speaks another ABI version");
    }
    const buffer = probe.#call("oxidevm_netstack_buffer_ptr");
    if (buffer + NETSTACK_BUFFER_BYTES > memory.buffer.byteLength) throw loadError("version", "the router's buffer lies outside its memory");
    const router = new NetstackRouter(exports, memory, buffer);
    try {
      router.init(seed, nowMilliseconds);
    } catch (error: unknown) {
      if (error instanceof VMError && error.code === "RELAY_ERROR" && error.detail?.["reason"] === "init") {
        throw loadError("init", "the router did not start");
      }
      throw error;
    }
    return router;
  }

  init(seed: bigint, nowMilliseconds: number): void {
    const [seedLow, seedHigh] = halves(seed);
    const [nowLow, nowHigh] = halves(BigInt(Math.max(0, Math.floor(nowMilliseconds))));
    if (this.#call("oxidevm_netstack_init", seedLow, seedHigh, nowLow, nowHigh) !== 0) {
      throw new VMError("RELAY_ERROR", "the router did not start", { reason: "init" });
    }
  }

  framesIn(records: Uint8Array): number {
    if (records.byteLength > NETSTACK_BUFFER_BYTES) throw new RangeError("frame records exceed the router's buffer");
    this.#view(records.byteLength).set(records);
    return this.#checked(this.#call("oxidevm_netstack_frames_in", records.byteLength), "frames_in");
  }

  framesOut(maximumBytes: number): Uint8Array<ArrayBuffer> {
    const length = this.#call("oxidevm_netstack_frames_out", Math.min(maximumBytes, NETSTACK_BUFFER_BYTES));
    return this.#view(this.#checked(length, "frames_out")).slice();
  }

  poll(nowMilliseconds: number): number | undefined {
    const [low, high] = halves(BigInt(Math.max(0, Math.floor(nowMilliseconds))));
    const delay = this.#call("oxidevm_netstack_poll", low, high);
    return delay === INVALID ? undefined : delay;
  }

  open(port: number): RouterOpen {
    const id = this.#checked(this.#call("oxidevm_netstack_tcp_open", port), "tcp_open");
    return id === 0 ? { kind: "busy" } : { kind: "opening", id };
  }

  status(id: number): RouterConnectionStatus {
    return decodeRouterConnectionStatus(this.#call("oxidevm_netstack_tcp_status", id));
  }

  send(id: number, bytes: Uint8Array): number {
    const length = Math.min(bytes.byteLength, NETSTACK_BUFFER_BYTES);
    this.#view(length).set(bytes.subarray(0, length));
    const accepted = this.#checked(this.#call("oxidevm_netstack_tcp_send", id, length), "tcp_send");
    if (accepted > length) throw protocolError("the router took more bytes than it was given");
    return accepted;
  }

  receive(id: number, maximumBytes: number): Uint8Array<ArrayBuffer> {
    const maximum = Math.min(maximumBytes, NETSTACK_BUFFER_BYTES);
    const length = this.#checked(this.#call("oxidevm_netstack_tcp_receive", id, maximum), "tcp_receive");
    if (length > maximum) throw protocolError("the router returned more bytes than were asked for");
    return this.#view(length).slice();
  }

  close(id: number): void {
    this.#call("oxidevm_netstack_tcp_close", id);
  }

  counters(): Uint8Array<ArrayBuffer> {
    const length = this.#call("oxidevm_netstack_counters");
    if (length > NETSTACK_BUFFER_BYTES) throw protocolError("the router's counters exceed its buffer");
    return this.#view(length).slice();
  }

  setNetwork(generation: number, enabled: boolean): void {
    if (!Number.isInteger(generation) || generation < 1 || generation >= 0xffff_ffff) throw protocolError("Invalid relay generation");
    this.#checked(this.#call("oxidevm_netstack_network_set", generation, Number(enabled)), "network_set");
  }
  egressNext(): RouterEgressEvent | undefined {
    const length = this.#checked(this.#call("oxidevm_netstack_egress_next"), "egress_next");
    return length === 0 ? undefined : decodeRouterEgressEvent(this.#view(length).slice());
  }
  egressComplete(generation: number, id: number, kind: 1 | 2 | 3 | 4 | 5, bytes: Uint8Array = new Uint8Array()): boolean {
    if (bytes.byteLength > 4096) throw protocolError("Invalid DNS completion size");
    this.#view(bytes.byteLength).set(bytes);
    return this.#call("oxidevm_netstack_egress_complete", generation, id, kind, bytes.byteLength) !== INVALID;
  }
  egressStatus(generation: number, id: number): number { return decodeRouterEgressStatus(this.#call("oxidevm_netstack_egress_status", generation, id)); }
  egressSend(generation: number, id: number, bytes: Uint8Array): number {
    const length = Math.min(bytes.byteLength, 16384); this.#view(length).set(bytes.subarray(0,length));
    const accepted = this.#checked(this.#call("oxidevm_netstack_egress_send", generation, id, length), "egress_send");
    if (accepted > length) throw protocolError("Outbound socket took excess bytes"); return accepted;
  }
  egressReceive(generation: number, id: number, maximum: number): Uint8Array<ArrayBuffer> {
    const length = this.#checked(this.#call("oxidevm_netstack_egress_receive", generation, id, Math.min(maximum,16384)), "egress_receive");
    if (length > maximum || length > 16384) throw protocolError("Outbound socket returned excess bytes"); return this.#view(length).slice();
  }

  /** One export call: a trap is RELAY_ERROR, and the result is read as a u32. */
  #call(name: NetstackExport, ...args: readonly number[]): number {
    const operation = this.#exports[name];
    if (typeof operation !== "function") throw loadError("exports", `the router module does not export ${name}`);
    let result: unknown;
    try {
      result = Reflect.apply(operation, undefined, args);
    } catch (error: unknown) {
      if (error instanceof WebAssembly.RuntimeError) throw new VMError("RELAY_ERROR", "the router trapped", { reason: "trap" });
      throw error;
    }
    if (typeof result !== "number") throw protocolError(`the router's ${name} returned no number`);
    return result >>> 0;
  }

  #checked(value: number, name: string): number {
    if (value === INVALID) throw protocolError(`the router refused a ${name} call`);
    return value;
  }

  /** The I/O buffer's first `length` bytes, viewed over the memory as it is now. */
  #view(length: number): Uint8Array<ArrayBuffer> {
    if (length > NETSTACK_BUFFER_BYTES || this.#buffer + length > this.#memory.buffer.byteLength) {
      throw protocolError("the router's buffer lies outside its memory");
    }
    return new Uint8Array(this.#memory.buffer, this.#buffer, length);
  }
}

function halves(value: bigint): readonly [number, number] {
  return [Number(value & 0xffff_ffffn), Number((value >> 32n) & 0xffff_ffffn)];
}

function loadError(reason: "fetch" | "compile" | "exports" | "version" | "init", message: string): VMError {
  return new VMError("CORE_LOAD_FAILED", message, { component: "netstack", reason });
}

function protocolError(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
