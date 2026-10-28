import { AttentionReceipts, createAttentionCounter, type AttentionCounter } from "../../host-attention.js";
import {
  JIT_COMPILER_PROTOCOL_VERSION,
  type JitCompilerRequest,
  decodeJitCompilerResponse,
} from "./jit-compiler-protocol.js";

/** The compiler worker as the execution worker uses it. */
export interface JitCompilerTransport {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
}

/** One rearmable timer. */
export interface JitCompilerTimer {
  arm(callback: () => void, milliseconds: number): void;
  cancel(): void;
}

/** What the client needs from its worker: a compiler, a clock, a timer and, when the page is
 * cross-origin isolated, shared memory for the ready counter. */
export interface JitCompilerHost {
  readonly createTransport: () => JitCompilerTransport;
  readonly now: () => number;
  readonly timer: JitCompilerTimer;
  readonly sharedCounter: () => AttentionCounter | null;
}

export interface JitCompilerLimits {
  /** Compiles in flight at once. */
  readonly maximumInFlight: number;
  /** A compile still unanswered after this long abandons every compile and restarts the worker. */
  readonly timeoutMilliseconds: number;
  /** Worker failures after which the client stops accepting compiles. */
  readonly maximumFailures: number;
}

export const DEFAULT_JIT_COMPILER_LIMITS: JitCompilerLimits = {
  maximumInFlight: 256,
  timeoutMilliseconds: 10_000,
  maximumFailures: 3,
};

export type JitCompileAbandonReason = "worker-failure" | "timeout";

export type JitCompileResult =
  | {
      readonly kind: "compiled";
      readonly id: number;
      readonly module: WebAssembly.Module;
      readonly compileMilliseconds: number;
    }
  | {
      readonly kind: "failed";
      readonly id: number;
      readonly errorName: string;
      readonly reason: string;
    }
  | { readonly kind: "abandoned"; readonly id: number; readonly reason: JitCompileAbandonReason };

/** Why the client accepts no compiles. */
export type JitCompilerUnavailableReason = "compiler-unavailable" | "compiler-failed";

const MAX_ID = 0x7fff_ffff;

/** Sends translated modules to the JIT compiler worker and collects the compiled modules. Every
 * submitted compile yields exactly one result, unless `reset` drops it. */
export class JitCompilerClient {
  readonly #host: JitCompilerHost;
  readonly #limits: JitCompilerLimits;
  readonly #inFlight = new Map<number, number>();
  #results: JitCompileResult[] = [];
  #transport: JitCompilerTransport | undefined;
  #ready: AttentionCounter | null = null;
  #received: AttentionReceipts | undefined;
  #epoch = 1;
  #nextId = 1;
  #failures = 0;
  #unavailable: JitCompilerUnavailableReason | null = null;
  #timerArmed = false;

  constructor(host: JitCompilerHost, limits: JitCompilerLimits = DEFAULT_JIT_COMPILER_LIMITS) {
    this.#host = host;
    this.#limits = limits;
  }

  /** Why compiles cannot be sent, or null while the client works. */
  get unavailable(): JitCompilerUnavailableReason | null {
    return this.#unavailable;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Whether another compile can be sent now. */
  accepts(): boolean {
    return this.#unavailable === null && this.#inFlight.size < this.#limits.maximumInFlight;
  }

  /** Sends `bytes`, transferring their buffer, and returns the compile's ID. Call only when
   * `accepts()`; a send failure becomes an abandoned result. */
  submit(bytes: Uint8Array<ArrayBuffer>): number {
    const id = this.#nextId;
    this.#nextId = this.#nextId === MAX_ID ? 1 : this.#nextId + 1;
    this.#inFlight.set(id, this.#host.now());
    const transport = this.#connect();
    if (transport === undefined) {
      this.#abandonInFlight("worker-failure");
      return id;
    }
    const request: JitCompilerRequest = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "compile",
      id,
      epoch: this.#epoch,
      bytes,
    };
    try {
      transport.postMessage(request, [bytes.buffer]);
    } catch {
      this.#failWorker();
      return id;
    }
    this.#armTimer();
    return id;
  }

  /** Whether a result is waiting in `take`, or the compiler has posted one this worker has not
   * received yet: the guest's slice can end so the result is installed sooner. */
  resultReady(): boolean {
    return this.#results.length !== 0 || this.#received?.pending() === true;
  }

  /** Whether the compiler signals posted results through the shared ready counter. */
  signalsReady(): boolean {
    return this.#ready !== null;
  }

  /** Whether results wait in `take`. */
  hasResults(): boolean {
    return this.#results.length !== 0;
  }

  /** The results received so far, oldest first. */
  take(): JitCompileResult[] {
    const results = this.#results;
    this.#results = [];
    return results;
  }

  /** Forgets every compile in flight; their late results are ignored. */
  reset(): void {
    this.#inFlight.clear();
    this.#results = [];
    this.#epoch = this.#epoch === MAX_ID ? 1 : this.#epoch + 1;
    this.#cancelTimer();
  }

  dispose(): void {
    this.reset();
    this.#disconnect();
  }

  #connect(): JitCompilerTransport | undefined {
    if (this.#transport !== undefined) return this.#transport;
    let transport: JitCompilerTransport;
    try {
      transport = this.#host.createTransport();
    } catch {
      this.#unavailable = "compiler-unavailable";
      return undefined;
    }
    transport.addEventListener("message", this.#receive);
    transport.addEventListener("error", this.#workerFailure);
    transport.addEventListener("messageerror", this.#workerFailure);
    this.#transport = transport;
    this.#ready = this.#host.sharedCounter();
    this.#received = this.#ready === null ? undefined : new AttentionReceipts(this.#ready);
    const attach: JitCompilerRequest = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "attach",
      ready: this.#ready,
    };
    try {
      transport.postMessage(attach, []);
    } catch {
      this.#failWorker();
      return undefined;
    }
    return transport;
  }

  readonly #receive = (event: Event): void => {
    if (!(event instanceof MessageEvent)) return this.#failWorker();
    let response;
    try {
      response = decodeJitCompilerResponse(event.data);
    } catch {
      this.#failWorker();
      return;
    }
    this.#received?.delivered();
    if (response.epoch !== this.#epoch || !this.#inFlight.delete(response.id)) return;
    this.#results.push(
      response.type === "compiled"
        ? {
            kind: "compiled",
            id: response.id,
            module: response.module,
            compileMilliseconds: response.compileMilliseconds,
          }
        : {
            kind: "failed",
            id: response.id,
            errorName: response.errorName,
            reason: response.reason,
          },
    );
    if (this.#inFlight.size === 0) this.#cancelTimer();
  };

  readonly #workerFailure = (): void => this.#failWorker();

  #failWorker(): void {
    this.#abandonInFlight("worker-failure");
    this.#disconnect();
    this.#failures += 1;
    if (this.#failures >= this.#limits.maximumFailures) this.#unavailable = "compiler-failed";
  }

  #abandonInFlight(reason: JitCompileAbandonReason): void {
    for (const id of this.#inFlight.keys()) this.#results.push({ kind: "abandoned", id, reason });
    this.#inFlight.clear();
    this.#cancelTimer();
  }

  #disconnect(): void {
    const transport = this.#transport;
    if (transport === undefined) return;
    transport.removeEventListener("message", this.#receive);
    transport.removeEventListener("error", this.#workerFailure);
    transport.removeEventListener("messageerror", this.#workerFailure);
    transport.terminate();
    this.#transport = undefined;
    this.#ready = null;
    this.#received = undefined;
  }

  #armTimer(): void {
    if (this.#timerArmed) return;
    this.#timerArmed = true;
    this.#host.timer.arm(this.#timeout, this.#limits.timeoutMilliseconds);
  }

  #cancelTimer(): void {
    if (!this.#timerArmed) return;
    this.#timerArmed = false;
    this.#host.timer.cancel();
  }

  readonly #timeout = (): void => {
    this.#timerArmed = false;
    let oldest = Number.POSITIVE_INFINITY;
    for (const submittedAt of this.#inFlight.values()) oldest = Math.min(oldest, submittedAt);
    if (oldest === Number.POSITIVE_INFINITY) return;
    const waited = this.#host.now() - oldest;
    if (waited < this.#limits.timeoutMilliseconds) {
      this.#timerArmed = true;
      this.#host.timer.arm(this.#timeout, this.#limits.timeoutMilliseconds - waited);
      return;
    }
    this.#abandonInFlight("timeout");
    this.#disconnect();
  };
}

/** The browser host: a module worker, `performance.now`, `setTimeout` and, when cross-origin
 * isolated, a shared ready counter. */
export function browserJitCompilerHost(): JitCompilerHost {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    createTransport: () => new Worker(
      new URL("../jit-compiler.worker.js", import.meta.url),
      { type: "module", name: "oxidevm-jit-compiler" },
    ),
    now: () => performance.now(),
    timer: {
      arm(callback, milliseconds) {
        if (handle !== undefined) clearTimeout(handle);
        handle = setTimeout(callback, milliseconds);
      },
      cancel() {
        if (handle !== undefined) clearTimeout(handle);
        handle = undefined;
      },
    },
    sharedCounter: createAttentionCounter,
  };
}
