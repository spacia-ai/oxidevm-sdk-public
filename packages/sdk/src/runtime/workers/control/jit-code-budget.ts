import { VMError } from "../../errors.js";
import {
  emptyJitCodeRefusals,
  type SystemJitCodeProfile,
  type SystemJitCodeRefusalReason,
} from "../../protocol/system-trace-jit-code.js";
import {
  estimateJitCodeBytes,
  type JitCodeBudgetPolicy,
  type JitEnginePolicy,
} from "./jit-engine-policy.js";

/**
 * The executable memory one core's compiled translations hold, estimated per compiled unit (one
 * engine module: a standalone translation or a linked batch), and the code budget that bounds it.
 *
 * Ownership and correctness dependencies:
 * - A unit is live while at least one live or dormant block (`jit-blocks.ts`, `jit-dormant.ts`)
 *   holds its instance; the store adds a member when it installs a newly compiled block and
 *   releases it whenever a block leaves the store for good (eviction other than to the dormant
 *   tier, dormant retirement, binding clears). A dormant reactivation keeps its membership.
 * - A unit is dead once no member holds it: the store keeps no reference to its instance or
 *   module, the dispatch tables' entries were cleared, and the compiler client keeps no results.
 *   Its executable memory returns only when the engine's collector frees the instance; the
 *   `FinalizationRegistry` callback for the instance is the only signal of that, and it reclaims
 *   the unit. There is no generation to validate: the registry holds the unit, never the
 *   instance, so registration cannot keep code alive.
 * - Compiles reserve their estimate when admitted and release it when they install, fail, are
 *   abandoned or are discarded (`jit-runtime.ts`, `jit-deferred-install.ts`).
 * - With a budget (`jit-engine-policy.ts`), admission first lets the store evict live blocks
 *   (reason `code-budget`) until live code and reservations fit the eviction target, then
 *   requests a collection of dead code past the threshold, and refuses (typed reasons) when live
 *   code still exceeds the budget or dead code the collector has not returned exceeds the slack.
 *   A refused site runs on the interpreter from its instruction boundary; nothing guest-visible
 *   changes.
 *
 * Counters cover the core's lifetime: dead code of an earlier runtime generation stays in the
 * engine until collected, so it stays here too.
 */
export interface JitCodeUnit {
  readonly estimatedBytes: number;
  members: number;
  state: "live" | "dead" | "reclaimed";
}

/** Notifies `onReclaimed` when `target` has been collected. */
export interface JitCodeFinalization {
  register(target: object, unit: JitCodeUnit): void;
}

/** Makes a transient allocation of `bytes` so the engine's malloc-bytes trigger collects. */
export type JitCodeCollector = (bytes: number) => void;

export interface JitCodeBudgetHost {
  readonly finalization?: (onReclaimed: (unit: JitCodeUnit) => void) => JitCodeFinalization;
  readonly collector?: JitCodeCollector;
  readonly now?: () => number;
}

export class JitCodeBudget {
  readonly policy: JitEnginePolicy;
  readonly #finalization: JitCodeFinalization;
  readonly #collector: JitCodeCollector;
  readonly #now: () => number;
  readonly #refusals = emptyJitCodeRefusals();
  #units = 0;
  #liveUnits = 0;
  #deadUnits = 0;
  #reclaimedUnits = 0;
  #retainedBytes = 0;
  #deadBytes = 0;
  #reservedBytes = 0;
  #peakRetainedBytes = 0;
  #reclaimedBytes = 0;
  #collectionRequests = 0;
  #collectionRequestBytes: number;
  #lastRequestAt = Number.NEGATIVE_INFINITY;
  #reclaimedAtLastRequest = 0;

  constructor(policy: JitEnginePolicy, host: JitCodeBudgetHost = {}) {
    this.policy = policy;
    this.#finalization = (host.finalization ?? browserJitCodeFinalization)((unit) => {
      this.#reclaim(unit);
    });
    this.#collector = host.collector ?? transientAllocation;
    this.#now = host.now ?? (() => performance.now());
    this.#collectionRequestBytes = policy.codeBudget?.collectionRequestBytes ?? 0;
  }

  get budget(): JitCodeBudgetPolicy | null {
    return this.policy.codeBudget;
  }

  /** Estimated bytes of live units. */
  get liveBytes(): number {
    return this.#retainedBytes - this.#deadBytes;
  }

  get deadBytes(): number {
    return this.#deadBytes;
  }

  get reservedBytes(): number {
    return this.#reservedBytes;
  }

  /** Estimated executable memory of one module of `wasmBytes` bytes. */
  estimate(wasmBytes: number): number {
    return estimateJitCodeBytes(this.policy.estimate, wasmBytes);
  }

  /** Whether live code and reservations, with `incoming`, exceed the eviction target. */
  overEvictionTarget(incoming: number): boolean {
    const budget = this.policy.codeBudget;
    return budget !== null
      && this.liveBytes + this.#reservedBytes + incoming > budget.evictionTargetBytes;
  }

  /** Whether live code and reservations, with `incoming`, exceed the budget. */
  overBudget(incoming: number): boolean {
    const budget = this.policy.codeBudget;
    return budget !== null
      && this.liveBytes + this.#reservedBytes + incoming > budget.budgetBytes;
  }

  /**
   * Admits a compile of `incoming` estimated bytes, after the store has evicted what it could:
   * reserves it and returns null, or returns why it is refused. Requests a collection when dead
   * code passed the threshold.
   */
  admit(incoming: number): SystemJitCodeRefusalReason | null {
    const budget = this.policy.codeBudget;
    if (budget !== null) {
      this.#requestCollection(budget);
      const refusal = this.overBudget(incoming)
        ? "live-budget"
        : this.#retainedBytes + this.#reservedBytes + incoming
            > budget.budgetBytes + budget.unreclaimedSlackBytes
          ? "unreclaimed-code"
          : null;
      if (refusal !== null) {
        this.#refusals[refusal] += 1;
        return refusal;
      }
    }
    this.#reservedBytes += incoming;
    return null;
  }

  /** Ends an admitted compile's reservation, whatever became of it. */
  releaseReservation(bytes: number): void {
    if (bytes > this.#reservedBytes) {
      throw new VMError("VM_FAULT", "JIT code reservation accounting is corrupt");
    }
    this.#reservedBytes -= bytes;
  }

  /** A compiled module was instantiated as `target`; it is dead until a block holds it. */
  register(target: object, estimatedBytes: number): JitCodeUnit {
    const unit: JitCodeUnit = { estimatedBytes, members: 0, state: "dead" };
    this.#units += 1;
    this.#deadUnits += 1;
    this.#retainedBytes += estimatedBytes;
    this.#deadBytes += estimatedBytes;
    this.#peakRetainedBytes = Math.max(this.#peakRetainedBytes, this.#retainedBytes);
    this.#finalization.register(target, unit);
    return unit;
  }

  /** A newly installed block holds `unit`. */
  addMember(unit: JitCodeUnit): void {
    if (unit.state === "reclaimed") {
      throw new VMError("VM_FAULT", "a reclaimed JIT code unit was installed");
    }
    unit.members += 1;
    if (unit.state === "dead") {
      unit.state = "live";
      this.#deadUnits -= 1;
      this.#liveUnits += 1;
      this.#deadBytes -= unit.estimatedBytes;
    }
  }

  /** A block holding `unit` left the store for good. */
  releaseMember(unit: JitCodeUnit): void {
    if (unit.state !== "live" || unit.members === 0) {
      throw new VMError("VM_FAULT", "JIT code unit membership is corrupt");
    }
    unit.members -= 1;
    if (unit.members === 0) {
      unit.state = "dead";
      this.#liveUnits -= 1;
      this.#deadUnits += 1;
      this.#deadBytes += unit.estimatedBytes;
    }
  }

  profile(): SystemJitCodeProfile {
    return {
      family: this.policy.family,
      budgetBytes: this.policy.codeBudget?.budgetBytes ?? null,
      units: this.#units,
      liveUnits: this.#liveUnits,
      deadUnits: this.#deadUnits,
      reclaimedUnits: this.#reclaimedUnits,
      retainedBytes: this.#retainedBytes,
      deadBytes: this.#deadBytes,
      reservedBytes: this.#reservedBytes,
      peakRetainedBytes: this.#peakRetainedBytes,
      reclaimedBytes: this.#reclaimedBytes,
      refusals: { ...this.#refusals },
      collectionRequests: this.#collectionRequests,
      collectionRequestBytes: this.#collectionRequestBytes,
    };
  }

  #reclaim(unit: JitCodeUnit): void {
    if (unit.state === "reclaimed") return;
    if (unit.state === "live") {
      // A live member holds the instance strongly, so the engine cannot have collected it.
      this.#liveUnits -= 1;
    } else {
      this.#deadUnits -= 1;
      this.#deadBytes -= unit.estimatedBytes;
    }
    unit.state = "reclaimed";
    this.#reclaimedUnits += 1;
    this.#retainedBytes -= unit.estimatedBytes;
    this.#reclaimedBytes += unit.estimatedBytes;
  }

  /** Asks the engine to collect once dead code passes the threshold, at most once per interval;
   * a request no reclamation answered by the next one is doubled, up to the maximum. */
  #requestCollection(budget: JitCodeBudgetPolicy): void {
    if (this.#deadBytes < budget.collectionThresholdBytes) return;
    const now = this.#now();
    if (now - this.#lastRequestAt < budget.collectionIntervalMilliseconds) return;
    if (this.#collectionRequests !== 0 && this.#reclaimedUnits === this.#reclaimedAtLastRequest) {
      this.#collectionRequestBytes = Math.min(
        this.#collectionRequestBytes * 2,
        budget.maximumCollectionRequestBytes,
      );
    }
    this.#lastRequestAt = now;
    this.#reclaimedAtLastRequest = this.#reclaimedUnits;
    this.#collectionRequests += 1;
    this.#collector(this.#collectionRequestBytes);
  }
}

/** Store membership of a block's unit; AOT blocks have none. */
export function releaseJitCodeMember(
  code: JitCodeBudget,
  unit: JitCodeUnit | null,
): void {
  if (unit !== null) code.releaseMember(unit);
}

function browserJitCodeFinalization(
  onReclaimed: (unit: JitCodeUnit) => void,
): JitCodeFinalization {
  const registry = new FinalizationRegistry<JitCodeUnit>(onReclaimed);
  return { register: (target, unit) => { registry.register(target, unit); } };
}

/**
 * SpiderMonkey charges `ArrayBuffer` contents to the garbage collector's malloc trigger but not
 * Wasm code, so a transient untouched buffer starts the collection that dead code alone never
 * does. The buffer is never written; an engine that cannot reserve it simply skips the request.
 */
function transientAllocation(bytes: number): void {
  try {
    const buffer = new ArrayBuffer(bytes);
    if (buffer.byteLength !== bytes) throw new RangeError("short transient allocation");
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
}
