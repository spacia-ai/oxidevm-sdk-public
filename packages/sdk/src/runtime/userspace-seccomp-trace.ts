import { VMError } from "./errors.ts";

export type UserspaceSeccompTrace =
  | { readonly kind: "strict"; readonly action: "allow" | "kill" }
  | { readonly kind: "filter"; readonly programId: bigint; readonly instruction: number; readonly value: number; readonly flags: number };

export function decodeSeccompTrace(bytes: Uint8Array, view: DataView, offset: number): UserspaceSeccompTrace | undefined {
  const tag = view.getUint8(offset);
  const flags = view.getUint8(offset + 1);
  if ((flags & ~0x17) !== 0) throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  if (tag <= 2) {
    if (flags !== 0 || bytes.subarray(offset + 2, offset + 16).some(byte => byte !== 0)) throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
    return tag === 0 ? undefined : { kind: "strict", action: tag === 1 ? "allow" : "kill" };
  }
  const programId = view.getBigUint64(offset + 8, true), instruction = view.getUint16(offset + 2, true);
  if (tag !== 3 || programId === 0n || instruction >= 4096) throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  return { kind: "filter", programId, instruction, value: view.getUint32(offset + 4, true), flags };
}
