import { decodeSeccompTrace, type UserspaceSeccompTrace } from "./userspace-seccomp-trace.ts";

/** Mirrors the closed Rust exit-origin wire invariant, including the actor of a group exit. */
export function isResourceExitSyscall(number: bigint, decision: UserspaceSeccompTrace | undefined, ownerTid: number, sourceTid: number): boolean {
  const sameTask = ownerTid === sourceTid;
  const ordinary = number === 60n ? sameTask : number === 59n || number === 231n || number === 322n;
  if (decision === undefined) return ordinary;
  if (decision.kind === "strict") return decision.action === "kill" ? sameTask : ordinary;
  const action = decision.value >>> 16;
  return action === 0x8000 || (action === 0 ? sameTask : ordinary && (action === 0x7fff || action === 0x7ffc));
}

import { VMError } from "./errors.ts";
import type { UserspaceRingFinalizationTrace } from "./userspace-ring-finalization-trace.ts";
export type ExitedResourceSource = Exclude<UserspaceRingFinalizationTrace["source"], { readonly kind: "worker" }>;
type Source = ExitedResourceSource;
export function decodeExitedResourceTraceSource(bytes: Uint8Array, view: DataView, at: number, admittedGuestTicks: bigint): Source {
  const tag = view.getUint8(at + 236), signal = view.getUint8(at + 237), instructionRip = view.getBigUint64(at + 240, true);
  const span = BigInt.asUintN(64, view.getBigUint64(at + 48, true) - view.getBigUint64(at + 40, true));
  if (tag === 1 && signal === 0 && instructionRip === 0n && span >= 1n && span <= 15n
    && isResourceExitSyscall(view.getBigUint64(at + 56, true), decodeSeccompTrace(bytes, view, at + 272), Number(view.getBigUint64(at + 200, true)), view.getUint32(at + 28, true))) return { kind: "syscall", admittedGuestTicks };
  if (tag === 2 && signal >= 1 && signal <= 64 && view.getBigUint64(at + 56, true) === 0xffff_ffff_ffff_ffffn
    && view.getUint8(at + 121) === 0 && !nonzero(bytes, at, 40, 56) && !nonzero(bytes, at, 64, 112) && !nonzero(bytes, at, 272, 288)) {
    return { kind: "signal", admittedGuestTicks, signal, instructionRip };
  }
  throw malformed();
}

function nonzero(bytes: Uint8Array, at: number, start: number, end: number): boolean { return bytes.subarray(at + start, at + end).some(byte => byte !== 0); }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace exited-resource source is malformed"); }
