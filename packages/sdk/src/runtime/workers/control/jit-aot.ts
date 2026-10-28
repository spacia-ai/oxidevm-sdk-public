import type { CoreJitAction, CorePendingAot } from "../../core-abi.js";
import { VMError } from "../../errors.js";
import type { Core, JitBlock } from "./core.js";
import { callNumber } from "./core.js";
import { synchronizeJitDispatchGeneration } from "./jit-runtime-helpers.js";
import { releaseJitCodeMember } from "./jit-code-budget.js";
import { clearDormantJitBlocks } from "./jit-dormant.js";
import type { PreparedAotMember, SystemAotRuntime } from "./aot-runtime.js";

type InstallAction = Extract<CoreJitAction, { readonly kind: "install" }>;
type InstallEntry = Pick<
  JitBlock,
  "cacheKey" | "bindingKey" | "artifactCacheKey" | "artifact" | "key" | "tier"
  | "instructions" | "profileModuleId" | "compileGeneration" | "codeUnit"
>;

interface AotInstallPorts {
  readonly loaded: Core;
  readonly runtime: SystemAotRuntime;
  readonly action: InstallAction;
  readonly install: (
    prepared: PreparedAotMember,
    pending: CorePendingAot,
  ) => JitBlock;
  readonly rollback: (block: JitBlock) => void;
  readonly imports: WebAssembly.Imports;
}

export function attemptAotInstall(ports: AotInstallPorts): boolean {
  const pending = ports.runtime.pending(ports.loaded);
  if (pending === undefined) return false;
  if (
    ports.action.cacheKey !== pending.cacheKey
    || ports.action.startRip !== pending.startRip
    || ports.action.instructionCount !== pending.instructionCount
  ) throw new VMError("VM_FAULT", "AOT pending identity does not match its install action");
  let installed: JitBlock | undefined;
  try {
    const prepared = ports.runtime.resolve(pending, ports.imports);
    if (prepared === undefined) {
      ports.runtime.decline(ports.loaded, pending);
      return true;
    }
    installed = ports.install(prepared, pending);
  } catch {
    if (installed !== undefined) ports.rollback(installed);
    ports.runtime.decline(ports.loaded, pending);
    return true;
  }
  const registration = callNumber(ports.loaded, "oxidevm_jit_aot_register", [
    ...pending.token,
    pending.cacheKey,
    installed.slot,
  ]);
  if (registration !== 0) {
    ports.rollback(installed);
    return true;
  }
  synchronizeJitDispatchGeneration(ports.loaded, installed);
  return true;
}

export function aotInstallEntry(
  action: InstallAction,
  bindingKey: string,
  artifactKey: string,
  prepared: PreparedAotMember,
  pending: CorePendingAot,
  compileGeneration: number,
): InstallEntry {
  return {
    cacheKey: action.cacheKey,
    bindingKey,
    artifactCacheKey: action.cacheKey,
    artifact: {
      kind: "aot",
      packSha256: pending.packSha256,
      memberIndex: pending.packMemberIndex,
      memberEntryOffset: pending.memberEntryOffset,
      imageBase: pending.imageBase,
      codePages: pending.codePages,
    },
    key: artifactKey,
    tier: "tier1",
    instructions: prepared.instructions,
    profileModuleId: prepared.profileModuleId,
    compileGeneration,
    codeUnit: null,
  };
}

export function clearJitBindings(loaded: Core): void {
  for (const block of loaded.jitBlocks.values()) {
    releaseJitCodeMember(loaded.jitCode, block.codeUnit);
    const status = callNumber(loaded, "oxidevm_jit_unregister", [
      block.artifactCacheKey,
      block.slot,
    ]);
    if (status !== 0) throw new VMError("VM_FAULT", "AOT binding clear failed");
    if (loaded.jitBlocksBySlot.get(block.slot) === block) {
      loaded.jitTable.set(block.slot, null);
      loaded.jitRecordingTable.set(block.slot, null);
    }
  }
  loaded.jitBlocks.clear();
  loaded.jitBlocksBySlot.clear();
  clearDormantJitBlocks(loaded);
  loaded.jitBlockBytes = 0;
  loaded.nextJitSlot = 0;
  loaded.evictedJitKeys.clear();
}
