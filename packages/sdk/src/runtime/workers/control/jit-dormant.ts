import { VMError } from "../../errors.js";
import type { Core, JitBlock } from "./core.js";
import { releaseJitCodeMember } from "./jit-code-budget.js";

/** The dormant JIT block cache: translations evicted from a dispatch slot keep
 * their instantiated module here so a later dispatch reinstalls them without
 * recompiling. It shares the byte cap with live and AOT blocks and retires in
 * insertion order. Instances stay scoped to one Core's memory/imports/table;
 * Rust registration revalidates CPU and physical-page generations, and trace
 * quarantine changes clear this tier before those instances can become active
 * again. */
export type DormantJitBlockState = Pick<
  Core,
  | "aotCacheBytes"
  | "dormantJitBlocks"
  | "dormantJitBlockBytes"
  | "jitBlockBytes"
  | "jitCacheBytes"
  | "jitCode"
>;

export function rememberDormantJitBlock(
  loaded: DormantJitBlockState,
  block: JitBlock,
): void {
  if (block.artifact.kind === "aot") return;
  const replaced = takeDormantJitBlock(loaded, block.key);
  if (replaced !== undefined) releaseJitCodeMember(loaded.jitCode, replaced.codeUnit);
  loaded.dormantJitBlocks.set(block.key, block);
  loaded.dormantJitBlockBytes += block.byteLength;
  trimDormantJitBlocks(loaded, 0);
}

export function takeDormantJitBlock(
  loaded: DormantJitBlockState,
  key: string,
): JitBlock | undefined {
  const block = loaded.dormantJitBlocks.get(key);
  if (block === undefined) return undefined;
  if (loaded.dormantJitBlockBytes < block.byteLength) {
    throw new VMError("VM_FAULT", "dormant JIT block accounting is corrupt");
  }
  loaded.dormantJitBlocks.delete(key);
  loaded.dormantJitBlockBytes -= block.byteLength;
  return block;
}

export function reactivateDormantJitBlock(
  loaded: DormantJitBlockState & Pick<Core, "traceProfile">,
  key: string,
): JitBlock | undefined {
  const block = takeDormantJitBlock(loaded, key);
  if (block !== undefined) {
    loaded.traceProfile.worker.dormantJitReactivations += 1;
    loaded.traceProfile.worker.dormantJitReactivationBytes += block.byteLength;
  }
  return block;
}

export function trimDormantJitBlocks(
  loaded: DormantJitBlockState,
  incomingBytes: number,
): void {
  while (
    jitBlockBytes(loaded) + incomingBytes > loaded.jitCacheBytes &&
    retireOldestDormantJitBlock(loaded)
  );
}

/** Retires the oldest dormant block and releases its code; false when the tier is empty. */
export function retireOldestDormantJitBlock(loaded: DormantJitBlockState): boolean {
  if (loaded.dormantJitBlocks.size === 0) return false;
  // ponytail: insertion order gives O(1) FIFO retirement without touching
  // active hits; replace it only if profiles show churn below the byte cap.
  const oldest = loaded.dormantJitBlocks.keys().next().value;
  const block = oldest === undefined ? undefined : takeDormantJitBlock(loaded, oldest);
  if (block === undefined) {
    throw new VMError("VM_FAULT", "dormant JIT block cache is corrupt");
  }
  releaseJitCodeMember(loaded.jitCode, block.codeUnit);
  return true;
}

/** Drops the dormant tier, releasing every block's code. */
export function clearDormantJitBlocks(loaded: DormantJitBlockState): void {
  for (const block of loaded.dormantJitBlocks.values()) {
    releaseJitCodeMember(loaded.jitCode, block.codeUnit);
  }
  loaded.dormantJitBlocks.clear();
  loaded.dormantJitBlockBytes = 0;
}

/** Bytes under the shared cap: live, dormant and AOT blocks together. */
export function jitBlockBytes(loaded: DormantJitBlockState): number {
  return loaded.aotCacheBytes + loaded.jitBlockBytes + loaded.dormantJitBlockBytes;
}
