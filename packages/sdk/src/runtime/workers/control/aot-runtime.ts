import type { CorePendingAot } from "../../core-abi.js";
import {
  type DecodedAotIndex,
  decodeAotIndex,
  decodeCorePendingAot,
} from "../../core-abi.js";
import { VMError } from "../../errors.js";
import type { PreparedManagedImage } from "../../protocol.js";
import type { SystemAotStatus } from "../../protocol/system-aot.js";
import type { JitTraceInstruction } from "../../protocol/system-trace-jit.js";
import {
  type Core,
  assertStatus,
  callNumber,
  readExportedBytes,
  stage,
} from "./core.js";
import {
  AOT_COMPILER_PROTOCOL_VERSION,
  type AotCompilerRequest,
  decodeAotCompilerResponse,
} from "./aot-compiler-protocol.js";
import { releaseAotPackBytes, reserveAotPackBytes } from "./jit-blocks.js";

interface CompilerTransport {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
}

type CompilerFactory = () => CompilerTransport;
type ReadyAot = Extract<PreparedManagedImage["aot"], { readonly kind: "ready" }>;
type Pack = ReadyAot["packs"][number];

interface CompiledPack {
  readonly descriptor: Pack;
  readonly module: WebAssembly.Module;
  readonly fetchMilliseconds: number;
  readonly hashMilliseconds: number;
  readonly compileMilliseconds: number;
  readonly beforeFirstEncounter: boolean;
}

export interface PreparedAotMember {
  readonly pending: CorePendingAot;
  readonly instance: WebAssembly.Instance;
  readonly trace: CallableFunction;
  readonly recordTrace: CallableFunction;
  readonly pack: Pack;
  readonly instructions: readonly JitTraceInstruction[];
  readonly profileModuleId: string | null;
}

const PHASE_PRIORITY: Readonly<Record<Pack["phase"], number>> = {
  command: 0,
  ready: 1,
  "first-request": 2,
  "warm-request": 3,
  rebuild: 4,
};

export function compareAotPackPriority(
  left: Pick<Pack, "phase" | "score" | "sha256">,
  right: Pick<Pack, "phase" | "score" | "sha256">,
): number {
  return PHASE_PRIORITY[left.phase] - PHASE_PRIORITY[right.phase]
    || right.score - left.score
    || left.sha256.localeCompare(right.sha256);
}

export class SystemAotRuntime {
  readonly #factory: CompilerFactory;
  readonly #compiled = new Map<string, CompiledPack>();
  readonly #instances = new Map<string, WebAssembly.Instance>();
  readonly #encountered = new Set<string>();
  readonly #failed = new Set<string>();
  #worker: CompilerTransport | undefined;
  #loaded: Core | undefined;
  #configuration: ReadyAot | undefined;
  #index: DecodedAotIndex | undefined;
  #queue: Pack[] = [];
  #active: { readonly id: number; readonly pack: Pack } | undefined;
  #runtimeEpoch = 0;
  #catalogGeneration = 0n;
  #nextRequestId = 1;
  #instantiateMilliseconds = 0;
  #armedForBoot = false;
  #skippedReason: Extract<PreparedManagedImage["aot"], { kind: "skipped" }>["reason"] = "no-catalog";

  constructor(factory: CompilerFactory = () => new Worker(
    new URL("../aot-compiler.worker.js", import.meta.url),
    { type: "module", name: "oxidevm-aot-compiler" },
  )) {
    this.#factory = factory;
  }

  initialize(): void {
    this.#clearCacheAccounting();
    this.#loaded = undefined;
    this.#disposeWorker();
    this.#configuration = undefined;
    this.#index = undefined;
    this.#queue = [];
    this.#compiled.clear();
    this.#instances.clear();
    this.#encountered.clear();
    this.#failed.clear();
    this.#runtimeEpoch = 0;
    this.#catalogGeneration = 0n;
    this.#nextRequestId = 1;
    this.#instantiateMilliseconds = 0;
    this.#armedForBoot = false;
    this.#skippedReason = "no-catalog";
  }

  configure(loaded: Core, configuration: PreparedManagedImage["aot"]): void {
    this.#clearCacheAccounting();
    this.#loaded = loaded;
    this.#disposeWorker();
    this.#configuration = undefined;
    this.#index = undefined;
    this.#queue = [];
    this.#compiled.clear();
    this.#instances.clear();
    this.#encountered.clear();
    this.#failed.clear();
    this.#runtimeEpoch += 1;
    this.#catalogGeneration += 1n;
    this.#instantiateMilliseconds = 0;
    this.#armedForBoot = true;
    if (configuration.kind === "skipped") {
      this.#skippedReason = configuration.reason;
      assertStatus(callNumber(loaded, "oxidevm_jit_aot_catalog_clear"));
      return;
    }
    if (configuration.coreRuntimeKey !== loaded.runtimeKey) {
      this.#skippedReason = "invalid-catalog";
      assertStatus(callNumber(loaded, "oxidevm_jit_aot_catalog_clear"));
      return;
    }
    const index = decodeAotIndex(configuration.index);
    reconcileIndex(index, configuration);
    stage(loaded, configuration.index);
    assertStatus(callNumber(loaded, "oxidevm_jit_aot_catalog_install", [configuration.index.byteLength]));
    this.#configuration = configuration;
    this.#index = index;
    this.#queue = [...configuration.packs].sort(compareAotPackPriority);
    this.#worker = this.#factory();
    this.#worker.addEventListener("message", this.#receive);
    this.#worker.addEventListener("error", this.#workerFailure);
    this.#worker.addEventListener("messageerror", this.#workerFailure);
    this.#compileNext();
  }

  prepareBoot(loaded: Core): void {
    if (!this.#armedForBoot) {
      this.#disposeWorker();
      this.#configuration = undefined;
      this.#index = undefined;
      this.#queue = [];
      this.#compiled.clear();
      this.#instances.clear();
      this.#encountered.clear();
      this.#failed.clear();
      this.#catalogGeneration += 1n;
      this.#skippedReason = "no-catalog";
      assertStatus(callNumber(loaded, "oxidevm_jit_aot_catalog_clear"));
    }
    this.#armedForBoot = false;
  }

  dispose(): void {
    this.initialize();
  }

  pending(loaded: Core): CorePendingAot | undefined {
    const length = callNumber(loaded, "oxidevm_jit_aot_pending_len");
    if (length === 0) return undefined;
    const record = readExportedBytes(loaded, "oxidevm_jit_aot_pending");
    if (record.byteLength !== length) {
      throw new VMError("VM_FAULT", "pending AOT record changed while being read");
    }
    return decodeCorePendingAot(record);
  }

  decline(loaded: Core, pending: CorePendingAot): void {
    assertStatus(callNumber(loaded, "oxidevm_jit_aot_decline", pending.token));
  }

  resolve(
    pending: CorePendingAot,
    imports: WebAssembly.Imports,
  ): PreparedAotMember | undefined {
    this.#encountered.add(pending.packSha256);
    if (pending.generation !== this.#catalogGeneration) return undefined;
    const compiled = this.#compiled.get(pending.packSha256);
    const index = this.#index;
    if (
      compiled === undefined || index === undefined
      || compiled.descriptor.bytes !== pending.packByteLength
      || pending.packMemberIndex >= compiled.descriptor.memberCount
    ) return undefined;
    const instanceKey = `${pending.packSha256}:${pending.imageBase.toString(16)}`;
    let instance = this.#instances.get(instanceKey);
    if (instance === undefined) {
      const started = performance.now();
      instance = new WebAssembly.Instance(compiled.module, {
        ...imports,
        oxidevm: {
          ...imports["oxidevm"],
          image_base: new WebAssembly.Global(
            { value: "i64", mutable: false },
            pending.imageBase,
          ),
        },
      });
      this.#instantiateMilliseconds += performance.now() - started;
      this.#instances.set(instanceKey, instance);
    }
    const memberTable: unknown = instance.exports["member_table"];
    const recordMemberTable: unknown = instance.exports["record_member_table"];
    if (!(memberTable instanceof WebAssembly.Table) || !(recordMemberTable instanceof WebAssembly.Table)) {
      throw new VMError("VM_FAULT", "AOT pack member tables are invalid");
    }
    const trace: unknown = memberTable.get(pending.packMemberIndex);
    const recordTrace: unknown = recordMemberTable.get(pending.packMemberIndex);
    if (typeof trace !== "function" || typeof recordTrace !== "function") {
      throw new VMError("VM_FAULT", "AOT pack member function is unavailable");
    }
    const packIndex = index.packs.findIndex((pack) => pack.sha256 === pending.packSha256);
    const member = index.members.find((candidate) =>
      candidate.packIndex === packIndex
      && candidate.packMemberIndex === pending.packMemberIndex
    );
    if (
      packIndex < 0 || member === undefined
      || member.entryOffset !== pending.memberEntryOffset
      || member.instructionCount !== pending.instructionCount
    ) throw new VMError("VM_FAULT", "AOT pack member does not match the verified index");
    return {
      pending,
      instance,
      trace,
      recordTrace,
      pack: compiled.descriptor,
      instructions: member.spans.map((span) => ({
        rip: pending.imageBase + span.imageOffset,
        semantic: span.semantic,
        retired: 1,
        instructionForm: span.instructionForm === 0xffff ? null : span.instructionForm,
      })),
      profileModuleId: member.profileModuleId === 0n
        ? null
        : member.profileModuleId.toString(16).padStart(16, "0"),
    };
  }

  status(): SystemAotStatus {
    const configuration = this.#configuration;
    return {
      kind: configuration === undefined ? "disabled" : "configured",
      reason: configuration === undefined ? this.#skippedReason : null,
      catalogSha256: configuration?.catalogSha256 ?? null,
      indexSha256: configuration?.indexSha256 ?? null,
      keyId: configuration?.keyId ?? null,
      signatureVerified: configuration?.signatureVerified ?? false,
      encounters: this.#encountered.size,
      instantiateMilliseconds: this.#instantiateMilliseconds,
      packs: (configuration?.packs ?? []).map((pack) => {
        const compiled = this.#compiled.get(pack.sha256);
        const state = compiled !== undefined
          ? "compiled"
          : this.#failed.has(pack.sha256)
            ? "failed"
            : this.#active?.pack.sha256 === pack.sha256
              ? "compiling"
              : "queued";
        return {
          sha256: pack.sha256,
          phase: pack.phase,
          bytes: pack.bytes,
          memberCount: pack.memberCount,
          state,
          beforeFirstEncounter: compiled?.beforeFirstEncounter ?? false,
          fetchMilliseconds: compiled?.fetchMilliseconds ?? 0,
          hashMilliseconds: compiled?.hashMilliseconds ?? 0,
          compileMilliseconds: compiled?.compileMilliseconds ?? 0,
        };
      }),
    };
  }

  readonly #receive = (event: Event): void => {
    if (!(event instanceof MessageEvent)) return this.#failWorker();
    let response;
    try {
      response = decodeAotCompilerResponse(event.data);
    } catch {
      this.#failWorker();
      return;
    }
    const active = this.#active;
    if (
      response.runtimeEpoch !== this.#runtimeEpoch
      || response.catalogGeneration !== this.#catalogGeneration
    ) return;
    if (
      active === undefined
      || response.id !== active.id
      || response.sha256 !== active.pack.sha256
    ) {
      this.#failWorker();
      return;
    }
    this.#active = undefined;
    if (response.type === "failed") {
      this.#failed.add(response.sha256);
    } else {
      this.#compiled.set(response.sha256, {
        descriptor: active.pack,
        module: response.module,
        fetchMilliseconds: response.fetchMilliseconds,
        hashMilliseconds: response.hashMilliseconds,
        compileMilliseconds: response.compileMilliseconds,
        beforeFirstEncounter: !this.#encountered.has(response.sha256),
      });
      const loaded = this.#loaded;
      if (loaded === undefined || !reserveAotPackBytes(loaded, active.pack.bytes)) {
        this.#compiled.delete(response.sha256);
        this.#failed.add(response.sha256);
      }
    }
    this.#compileNext();
  };

  readonly #workerFailure = (): void => this.#failWorker();

  #compileNext(): void {
    if (this.#worker === undefined || this.#active !== undefined) return;
    const pack = this.#queue.shift();
    if (pack === undefined) return;
    const id = this.#nextRequestId++;
    this.#active = { id, pack };
    const request: AotCompilerRequest = {
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "compile",
      id,
      runtimeEpoch: this.#runtimeEpoch,
      catalogGeneration: this.#catalogGeneration,
      url: pack.url,
      byteLength: pack.bytes,
      sha256: pack.sha256,
      sourceSha256: pack.sourceSha256,
      memberCount: pack.memberCount,
    };
    this.#worker.postMessage(request);
  }

  #failWorker(): void {
    if (this.#active !== undefined) this.#failed.add(this.#active.pack.sha256);
    for (const pack of this.#queue) this.#failed.add(pack.sha256);
    this.#queue = [];
    this.#active = undefined;
    this.#disposeWorker();
  }

  #disposeWorker(): void {
    const worker = this.#worker;
    if (worker === undefined) return;
    worker.removeEventListener("message", this.#receive);
    worker.removeEventListener("error", this.#workerFailure);
    worker.removeEventListener("messageerror", this.#workerFailure);
    worker.terminate();
    this.#worker = undefined;
    this.#active = undefined;
  }

  #clearCacheAccounting(): void {
    if (this.#loaded === undefined) return;
    releaseAotPackBytes(this.#loaded);
  }
}

function reconcileIndex(index: DecodedAotIndex, configuration: ReadyAot): void {
  if (index.packs.length !== configuration.packs.length) {
    throw new VMError("PROTOCOL_ERROR", "AOT catalog and index pack counts differ");
  }
  const catalogPacks = new Map(configuration.packs.map((pack) => [pack.sha256, pack]));
  for (const pack of index.packs) {
    const catalog = catalogPacks.get(pack.sha256);
    const source = index.sources[pack.sourceIndex];
    if (
      catalog === undefined || source === undefined
      || catalog.bytes !== pack.byteLength
      || catalog.memberCount !== pack.memberCount
      || catalog.phase !== pack.phase
      || catalog.sourceSha256 !== source
    ) throw new VMError("PROTOCOL_ERROR", "AOT catalog and index pack identity differ");
  }
}
