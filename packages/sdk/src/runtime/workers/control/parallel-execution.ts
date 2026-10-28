import { coreFailureError } from "../core-failure.js";
import { decodeRunResult } from "../../core-abi.js";
import { type CoreProbeExit } from "../../protocol.js";
import { VMError } from "../../errors.js";
import { assertStatus, callNumber, type Core } from "./core.js";

const CONTROL_GENERATION = 0;
const CONTROL_BARRIER = 1;
const CONTROL_CANCELLATION = 2;
const CONTROL_STOPPED = 3;
const CONTROL_ACK_BASE = 4;

interface ParallelVcpuRun {
  readonly exit: CoreProbeExit;
  readonly tier: "interpreter" | "jit";
  readonly residentInterpreted: bigint;
}

// TODO: application processors still compile every translation synchronously in their vCPU
// workers (vcpu.worker.ts). Give them the BSP's background compiler and deferred install
// (jit-deferred-install.ts, core `oxidevm_vcpu_*` twins of `oxidevm_jit_defer`/`_compile_settled`)
// and, with Phase 5, batched translations; see docs/baselines/jit-background-compile.md.
export class ParallelExecution {
  readonly #workers: ParallelWorker[];
  readonly #activeWorkers: number;
  readonly #control: Int32Array<SharedArrayBuffer>;
  readonly #onFailure: (error: VMError) => void;
  #generation = 0;
  #failed: VMError | undefined;
  started = false;

  private constructor(
    workers: ParallelWorker[],
    vcpus: 2 | 3 | 4,
    control: Int32Array<SharedArrayBuffer>,
    onFailure: (error: VMError) => void,
  ) {
    this.#workers = workers;
    this.#activeWorkers = vcpus - 1;
    this.#control = control;
    this.#onFailure = onFailure;
  }

  static async create(
    module: WebAssembly.Module,
    memory: WebAssembly.Memory,
    vcpus: 2 | 3 | 4,
    onFailure: (error: VMError) => void,
  ): Promise<ParallelExecution> {
    const control = new Int32Array(
      new SharedArrayBuffer(8 * Int32Array.BYTES_PER_ELEMENT),
    );
    const workers: ParallelWorker[] = [];
    const execution = new ParallelExecution(workers, vcpus, control, onFailure);
    try {
      for (let index = 1; index <= 4; index += 1) {
        workers.push(
          new ParallelWorker(
            index,
            (error) => execution.fail(error),
          ),
        );
      }
      await Promise.all(
        workers.map((worker) =>
          worker.request("instantiate", {
            module,
            memory,
            control: control.buffer,
            vcpu: worker.vcpu,
          }),
        ),
      );
      await Promise.all(
        workers.map((worker) => worker.request("initialize", {})),
      );
      return execution;
    } catch (error) {
      execution.dispose();
      throw error;
    }
  }

  start(loaded: Core): void {
    this.throwIfFailed();
    if (this.started) return;
    assertStatus(callNumber(loaded, "oxidevm_system_parallel_enable"));
    this.#generation = callNumber(
      loaded,
      "oxidevm_system_parallel_generation",
    );
    Atomics.store(this.#control, CONTROL_GENERATION, this.#generation);
    Atomics.store(this.#control, CONTROL_STOPPED, 0);
    this.started = true;
  }

  async run(budgets: readonly number[]): Promise<ParallelVcpuRun[]> {
    this.throwIfFailed();
    if (!this.started || budgets.length !== this.#activeWorkers) {
      throw new VMError("VM_FAULT", "parallel vCPU execution is not started");
    }
    try {
      return await Promise.all(
        budgets.map(async (maximumSteps, index) => {
          if (maximumSteps === 0) {
            return {
              exit: { kind: "step-limit", steps: 0n },
              tier: "interpreter",
              residentInterpreted: 0n,
            } as const;
          }
          const worker = this.#workers[index];
          if (worker === undefined) {
            throw new VMError("VM_FAULT", "parallel vCPU worker is unavailable");
          }
          const value = await worker.request("run", {
            generation: this.#generation,
            maximumSteps,
          });
          if (typeof value !== "object" || value === null) {
            throw new VMError("PROTOCOL_ERROR", "vCPU result is invalid");
          }
          const result = value as {
            readonly record?: unknown;
            readonly tier?: unknown;
            readonly residentInterpreted?: unknown;
          };
          if (
            !(result.record instanceof Uint8Array) ||
            (result.tier !== "interpreter" && result.tier !== "jit")
          ) {
            throw new VMError("PROTOCOL_ERROR", "vCPU result is invalid");
          }
          const exit = decodeRunResult(result.record);
          const residentInterpreted =
            result.tier === "jit" ? Number(result.residentInterpreted) : 0;
          if (
            !Number.isSafeInteger(residentInterpreted) ||
            residentInterpreted < 0 ||
            BigInt(residentInterpreted) > exit.steps
          ) {
            throw new VMError(
              "PROTOCOL_ERROR",
              "vCPU resident interpreter count is invalid",
            );
          }
          if (exit.kind === "adapter-exit") {
            throw new VMError(
              "UNSUPPORTED_SYSCALL",
              "parallel system execution requested an adapter exit",
            );
          }
          if (exit.kind === "internal-failure") {
            throw coreFailureError(exit);
          }
          return {
            exit,
            tier: result.tier,
            residentInterpreted: BigInt(residentInterpreted),
          };
        }),
      );
    } catch (error) {
      const failure =
        error instanceof VMError
          ? error
          : new VMError("VM_FAULT", String(error));
      this.fail(failure);
      throw failure;
    }
  }

  async barrier(): Promise<void> {
    this.throwIfFailed();
    if (!this.started) return;
    const epoch = Atomics.add(this.#control, CONTROL_BARRIER, 1) + 1;
    await Promise.all(
      this.#workers
        .slice(0, this.#activeWorkers)
        .map((worker) => worker.request("barrier", { epoch })),
    );
    for (let index = 0; index < this.#activeWorkers; index += 1) {
      if (Atomics.load(this.#control, CONTROL_ACK_BASE + index) !== epoch) {
        throw new VMError(
          "VM_FAULT",
          "vCPU pause barrier was not acknowledged",
        );
      }
    }
  }

  cancel(): void {
    Atomics.add(this.#control, CONTROL_CANCELLATION, 1);
  }

  async stop(loaded: Core): Promise<void> {
    if (!this.started) return;
    await this.barrier();
    Atomics.store(this.#control, CONTROL_STOPPED, 1);
    this.cancel();
    assertStatus(callNumber(loaded, "oxidevm_system_parallel_disable"));
    this.#generation = callNumber(
      loaded,
      "oxidevm_system_parallel_generation",
    );
    Atomics.store(this.#control, CONTROL_GENERATION, this.#generation);
    this.started = false;
  }

  dispose(): void {
    Atomics.store(this.#control, CONTROL_STOPPED, 1);
    this.cancel();
    for (const worker of this.#workers) worker.dispose();
    this.started = false;
  }

  private fail(error: VMError): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    this.cancel();
    this.#onFailure(error);
  }

  private throwIfFailed(): void {
    if (this.#failed !== undefined) throw this.#failed;
  }
}

class ParallelWorker {
  readonly vcpu: number;
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  readonly #onFailure: (error: VMError) => void;
  #nextRequestId = 1;
  #failed: VMError | undefined;

  constructor(
    vcpu: number,
    onFailure: (error: VMError) => void,
  ) {
    this.vcpu = vcpu;
    this.#onFailure = onFailure;
    this.#worker = new Worker(new URL("../vcpu.worker.js", import.meta.url), {
      name: `oxidevm-vcpu-${vcpu}`,
      type: "module",
    });
    this.#worker.addEventListener("message", (event) => this.receive(event.data));
    this.#worker.addEventListener("error", () =>
      this.fail(new VMError("VM_FAULT", `vCPU ${vcpu} worker crashed`)),
    );
    this.#worker.addEventListener("messageerror", () =>
      this.fail(
        new VMError("PROTOCOL_ERROR", `vCPU ${vcpu} response is invalid`),
      ),
    );
  }

  request(
    type: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#worker.postMessage({ requestId, type, ...value });
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.#worker.terminate();
    const stopped = new VMError(
      "VM_FAULT",
      `vCPU ${this.vcpu} worker stopped`,
    );
    this.#failed = stopped;
    for (const pending of this.#pending.values()) pending.reject(stopped);
    this.#pending.clear();
  }

  private receive(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.fail(new VMError("PROTOCOL_ERROR", "vCPU response is invalid"));
      return;
    }
    const response = value as {
      readonly requestId?: unknown;
      readonly ok?: unknown;
      readonly value?: unknown;
      readonly error?: unknown;
    };
    if (!Number.isInteger(response.requestId)) {
      this.fail(new VMError("PROTOCOL_ERROR", "vCPU response id is invalid"));
      return;
    }
    const pending = this.#pending.get(Number(response.requestId));
    if (pending === undefined) {
      this.fail(new VMError("PROTOCOL_ERROR", "unexpected vCPU response"));
      return;
    }
    this.#pending.delete(Number(response.requestId));
    if (response.ok === true) {
      pending.resolve(response.value);
    } else {
      pending.reject(
        new VMError(
          "VM_FAULT",
          typeof response.error === "string"
            ? response.error
            : "vCPU operation failed",
        ),
      );
    }
  }

  private fail(error: VMError): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#onFailure(error);
  }
}
