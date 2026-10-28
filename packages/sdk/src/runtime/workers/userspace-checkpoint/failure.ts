import { VMError } from "../../errors.js";
import type { CheckpointRaw } from "./raw.js";
import { decodeOwnerPath } from "./failure-causes.js";
import { CHECKPOINT_BEGIN_PHASES as PHASES, CHECKPOINT_DOMAINS as DOMAINS, CHECKPOINT_OWNERS as OWNERS } from "../../protocol/checkpoint-failure.js";

export function rejectBegin(raw: CheckpointRaw, speculative: boolean): never {
  raw.ok("failure_read");
  const bytes = raw.frame();
  if (bytes.length === 0) throw new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin");
  if (bytes.length !== 24) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phase = PHASES[view.getUint32(0, true) - 1];
  const domainCode = view.getUint32(4, true), domain = DOMAINS[domainCode - 1];
  const ownerCode = view.getUint32(8, true), nativeReason = view.getUint32(12, true);
  const scalar0 = view.getUint32(16, true), scalar1 = view.getUint32(20, true);
  const owner = domainCode === 4 ? OWNERS[ownerCode - 1] : undefined;
  if (phase === undefined || domain === undefined || (domainCode === 4 ? owner === undefined : ownerCode !== 0)) invalid();
  let nativeCauses: readonly string[] | undefined;
  if (owner !== undefined) nativeCauses = decodeOwnerPath(owner, nativeReason, scalar0, scalar1);
  else if (domainCode === 3) nativeCauses = decodeOwnerPath("memory", nativeReason, scalar0, scalar1);
  else {
    const maximum = domainCode === 1 ? 1 : domainCode === 2 ? 12 : domainCode === 5 ? 6 : 2;
    if (nativeReason === 0 || nativeReason > maximum) invalid();
    if (domainCode === 2 && nativeReason === 11) {
      if (scalar0 > 0xffff || scalar1 > 0xffff) invalid();
    } else if (scalar0 !== 0 || scalar1 !== 0) invalid();
  }
  throw new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin", {
    reason: "checkpoint-begin-rejected", phase, domain,
    ...(owner === undefined ? {} : { owner }), nativeReason, scalar0, scalar1,
    ...(nativeCauses === undefined ? {} : { nativeCauses }),
    // No round was published. The existing session aborts its staging, then freezes and
    // drains finite publication through the normal barrier before a fresh full capture.
    ...(speculative && phase === "initial-round" && domain === "runtime" && owner === "workspace" && nativeReason === 1
      ? { discardRounds: true } : {}),
  });
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Native checkpoint failure frame is invalid"); }
