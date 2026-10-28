import { JIT_DISPATCH_TABLE_ENTRIES } from "../../jit-cache.js";
import type { JitAotTrainingStats } from "../../protocol/system-trace-jit-aot.js";
import type { SystemTraceJitModule } from "../../protocol/system.js";

interface StoredModule {
  readonly module: SystemTraceJitModule;
  readonly revision: number;
}

interface ScoreEntry {
  readonly profileModuleId: string;
  readonly tier: SystemTraceJitModule["tier"];
  readonly score: number;
  readonly revision: number;
}

export class ProfileJitModuleStore {
  private readonly modules = new Map<string, StoredModule>();
  private readonly minimumHeap: ScoreEntry[] = [];

  get size(): number { return this.modules.size; }

  get(profileModuleId: string): SystemTraceJitModule | undefined {
    return this.modules.get(profileModuleId)?.module;
  }

  delete(profileModuleId: string): void {
    this.modules.delete(profileModuleId);
  }

  clear(): void {
    this.modules.clear();
    this.minimumHeap.length = 0;
  }

  *values(): IterableIterator<SystemTraceJitModule> {
    for (const stored of this.modules.values()) yield stored.module;
  }

  retain(module: SystemTraceJitModule): "retained" | "replaced" | "dropped" {
    const current = this.modules.get(module.profileModuleId);
    if (current !== undefined) {
      this.replace({
        module: {
          ...module,
          aotTraining: addTraining(current.module.aotTraining, module.aotTraining),
        },
        revision: current.revision + 1,
      });
      return "retained";
    }
    let replaced = false;
    if (this.modules.size >= JIT_DISPATCH_TABLE_ENTRIES) {
      const minimum = this.minimum();
      if (minimum === undefined || (module.tier === minimum.tier
        ? score(module) <= minimum.score
        : module.tier === "tier1")) return "dropped";
      this.modules.delete(minimum.profileModuleId);
      this.popMinimum();
      replaced = true;
    }
    this.replace({ module, revision: 1 });
    return replaced ? "replaced" : "retained";
  }

  recordOuterExecution(
    profileModuleId: string | null,
    retired: bigint,
  ): void {
    if (profileModuleId === null) return;
    const current = this.modules.get(profileModuleId);
    if (current === undefined) return;
    this.modules.set(profileModuleId, {
      module: {
        ...current.module,
        aotTraining: {
          ...current.module.aotTraining,
          outerEntries: current.module.aotTraining.outerEntries + 1,
          outerRetired: current.module.aotTraining.outerRetired + retired,
        },
      },
      revision: current.revision,
    });
  }

  private replace(stored: StoredModule): void {
    this.modules.set(stored.module.profileModuleId, stored);
    this.pushMinimum({
      profileModuleId: stored.module.profileModuleId,
      tier: stored.module.tier,
      score: score(stored.module),
      revision: stored.revision,
    });
    if (this.minimumHeap.length > JIT_DISPATCH_TABLE_ENTRIES * 4) {
      this.minimumHeap.length = 0;
      for (const value of this.modules.values()) {
        this.pushMinimum({
          profileModuleId: value.module.profileModuleId,
          tier: value.module.tier,
          score: score(value.module),
          revision: value.revision,
        });
      }
    }
  }

  private minimum(): ScoreEntry | undefined {
    for (;;) {
      const entry = this.minimumHeap[0];
      if (entry === undefined) return undefined;
      const current = this.modules.get(entry.profileModuleId);
      if (current?.revision === entry.revision && current.module.tier === entry.tier
        && score(current.module) === entry.score) {
        return entry;
      }
      this.popMinimum();
    }
  }

  private pushMinimum(entry: ScoreEntry): void {
    let index = this.minimumHeap.length;
    this.minimumHeap.push(entry);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.minimumHeap[parent];
      if (parentEntry === undefined || compareScores(parentEntry, entry) <= 0) break;
      this.minimumHeap[index] = parentEntry;
      index = parent;
    }
    this.minimumHeap[index] = entry;
  }

  private popMinimum(): void {
    const replacement = this.minimumHeap.pop();
    if (replacement === undefined || this.minimumHeap.length === 0) return;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      const leftEntry = this.minimumHeap[left];
      const rightEntry = this.minimumHeap[right];
      if (leftEntry === undefined) break;
      const child = rightEntry !== undefined && compareScores(rightEntry, leftEntry) < 0
        ? right
        : left;
      const childEntry = this.minimumHeap[child];
      if (childEntry === undefined || compareScores(replacement, childEntry) <= 0) break;
      this.minimumHeap[index] = childEntry;
      index = child;
    }
    this.minimumHeap[index] = replacement;
  }
}

function addTraining(
  left: JitAotTrainingStats,
  right: JitAotTrainingStats,
): JitAotTrainingStats {
  return {
    emissions: left.emissions + right.emissions,
    emittedBytes: left.emittedBytes + right.emittedBytes,
    compilationMilliseconds: left.compilationMilliseconds + right.compilationMilliseconds,
    instantiationMilliseconds: left.instantiationMilliseconds + right.instantiationMilliseconds,
    installationMilliseconds: left.installationMilliseconds + right.installationMilliseconds,
    outerEntries: left.outerEntries + right.outerEntries,
    outerRetired: left.outerRetired + right.outerRetired,
  };
}

function score(module: SystemTraceJitModule): number {
  return module.aotTraining.compilationMilliseconds
    + module.aotTraining.emittedBytes / 1_000_000_000;
}

function compareScores(left: ScoreEntry, right: ScoreEntry): number {
  return Number(left.tier === "tier2") - Number(right.tier === "tier2")
    || left.score - right.score
    || left.profileModuleId.localeCompare(right.profileModuleId);
}
