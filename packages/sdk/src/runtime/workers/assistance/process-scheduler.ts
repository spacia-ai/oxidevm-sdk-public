import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";

// Capture the trusted task primitive before installing application globals.
const TaskChannel = MessageChannel;
const maximumPending = 4096;
interface Immediate {
  ref(): Immediate;
  unref(): Immediate;
  hasRef(): boolean;
}
interface PendingCallback { readonly run: () => void; cancel(error: Error): void }
interface CheckCallback extends PendingCallback { referenced: boolean; active: boolean }


/** One process owns resource callbacks and its next-tick queue. Promise jobs
 * stay native: ticks admitted by a promise wait for its complete checkpoint,
 * then get their own checkpoint before the next resource callback. */
export class ProcessScheduler {
  readonly #channel = new TaskChannel();
  readonly #ticks: PendingCallback[] = [];
  readonly #callbacks: PendingCallback[] = [];
  readonly #immediates: CheckCallback[] = [];
  readonly #checkBatch: CheckCallback[] = [];
  readonly #handles = new WeakMap<object, CheckCallback>();
  readonly #externalWork: () => boolean;
  readonly #context: AsyncContext;
  readonly #failed: (error: unknown) => void;
  #exception: ((error: unknown) => boolean) | undefined;
  #posted = false;
  #disposed = false;
  #depth = 0;
  #waiting: PromiseWithResolvers<undefined> | undefined;

  constructor(context: AsyncContext, failed: (error: unknown) => void, externalWork: () => boolean = () => false) {
    this.#externalWork = externalWork;
    this.#context = context;
    this.#failed = failed;
    this.#channel.port1.onmessage = () => {
      this.#posted = false;
      try {
        if (this.#ticks.length !== 0) {
          this.#drainTicks();
          // Ticks may have queued promises; do not enter another resource
          // callback until the browser has completed that checkpoint.
        } else if (this.#checkBatch.length !== 0) {
          this.#runImmediate();
        } else {
          const callback = this.#callbacks.shift();
          if (callback !== undefined) this.run(callback.run);
          else if (this.#immediates.some(entry => entry.referenced) || this.#externalWork()) {
            this.#checkBatch.push(...this.#immediates.splice(0));
            this.#runImmediate();
          }
        }
      } catch (error) {
        let failure = error;
        try { if (this.handleException(error)) return; } catch (error) { failure = error; }
        this.dispose();
        this.#failed(failure);
      } finally { this.#changed(); this.#wake(); }
    };
  }

  setExceptionHandler(handler: (error: unknown) => boolean): void {
    if (this.#exception !== undefined) throw new VMError("PROTOCOL_ERROR", "Process exception owner is already set");
    this.#exception = handler;
  }
  handleException(error: unknown): boolean {
    if (this.#exception?.(error) !== true) return false;
    this.#changed(); this.#wake(); return true;
  }

  readonly nextTick = (callback: unknown, ...args: unknown[]): void => {
    if (typeof callback !== "function") {
      throw Object.assign(new TypeError("process.nextTick requires a function"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    this.#admit();
    this.#ticks.push(this.#callback("TickObject", () => { Reflect.apply(callback, undefined, args); }));
    this.#wake();
  };

  readonly setImmediate = (callback: unknown, ...args: unknown[]): Immediate => {
    if (typeof callback !== "function") throw Object.assign(new TypeError("setImmediate requires a function"), { code: "ERR_INVALID_ARG_TYPE" });
    this.#admit();
    const handle: Immediate = {
      ref: () => { if (entry.active) { entry.referenced = true; this.#wake(); } return handle; },
      unref: () => { entry.referenced = false; this.#changed(); return handle; },
      hasRef: () => entry.active && entry.referenced,
    };
    const entry: CheckCallback = { ...this.#callback("Immediate", () => { Reflect.apply(callback, handle, args); }), referenced: true, active: true };
    this.#handles.set(handle, entry);
    this.#immediates.push(entry);
    this.#wake();
    return handle;
  };

  readonly clearImmediate = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const entry = this.#handles.get(value);
    if (entry === undefined || !entry.active) return;
    entry.active = false;
    entry.cancel(new VMError("ABORTED", "Immediate was cancelled"));
    for (const queue of [this.#immediates, this.#checkBatch]) {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
    }
    this.#changed();
  };

  #runImmediate(): void {
    const entry = this.#checkBatch.shift();
    if (entry === undefined) return;
    entry.active = false;
    this.run(entry.run);
  }

  enqueue(callback: () => void): void {
    this.#admit();
    this.#callbacks.push(this.#callback("OxideVMCallback", callback));
    this.#wake();
  }

  execute<Result>(callback: () => Result): Promise<Result> {
    return new Promise((resolve, reject) => {
      this.#admit();
      const pending = this.#callback("OxideVMCallback", () => {
        try { resolve(callback()); } catch (error) { reject(error instanceof Error ? error : deserializeError(serializeUnknownError(error))); }
      });
      this.#callbacks.push({
        run: pending.run,
        cancel: error => { pending.cancel(error); reject(error); },
      });
      this.#wake();
    });
  }

  #callback(type: string, callback: () => void): PendingCallback {
    const run = this.#context.capture();
    const scope = this.#context.resources.create(type, callback);
    return {
      run: () => { try { run(() => scope.run(callback)); } finally { scope.destroy(); } },
      cancel: () => scope.destroy(),
    };
  }

  /** Enter a synchronous resource callback or CommonJS entry. Nested calls
   * remain one turn; plain EventEmitter.emit must never become a queued task. */
  run<Result>(callback: () => Result): Result {
    if (this.#disposed) throw new VMError("ABORTED", "Process scheduler is disposed");
    this.#depth++;
    let completed = false;
    try { const result = callback(); completed = true; return result; }
    finally {
      this.#depth--;
      if (this.#depth === 0 && completed) { this.#drainTicks(); this.#changed(); this.#wake(); }
    }
  }

  #drainTicks(): void {
    this.#depth++;
    try {
      for (let tick = this.#ticks.shift(); tick !== undefined; tick = this.#ticks.shift()) tick.run();
    } finally { this.#depth--; }
  }

  #admit(): void {
    if (this.#disposed) throw new VMError("ABORTED", "Process scheduler is disposed");
    if (this.#ticks.length + this.#callbacks.length + this.#immediates.length + this.#checkBatch.length >= maximumPending) {
      throw new VMError("QUOTA_EXCEEDED", "Process callback queue exhausted");
    }
  }

  #wake(): void {
    if (this.#disposed || this.#posted || this.#depth !== 0 || (!this.hasPending && !(this.#immediates.length !== 0 && this.#externalWork()))) return;
    this.#posted = true;
    this.#channel.port2.postMessage(null);
  }

  #changed(): void {
    if (!this.hasPending) { this.#waiting?.resolve(undefined); this.#waiting = undefined; }
  }

  get hasPending(): boolean { return this.#depth !== 0 || this.#ticks.length !== 0 || this.#callbacks.length !== 0
    || this.#checkBatch.length !== 0 || this.#immediates.some(entry => entry.referenced); }

  async idle(): Promise<void> {
    while (this.hasPending) { this.#waiting ??= Promise.withResolvers<undefined>(); await this.#waiting.promise; }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new VMError("ABORTED", "Process scheduler is disposed");
    for (const entry of [...this.#immediates.splice(0), ...this.#checkBatch.splice(0)]) { entry.active = false; entry.cancel(error); }
    for (const callback of [...this.#ticks.splice(0), ...this.#callbacks.splice(0)]) callback.cancel(error);
    this.#channel.port1.close(); this.#channel.port2.close();
    this.#changed();
  }
}
