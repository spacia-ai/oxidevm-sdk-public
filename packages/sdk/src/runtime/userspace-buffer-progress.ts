import { VMError } from "./errors.ts";

export type ProvidedAllocationOrigin =
  | { readonly kind: "recorded"; readonly run: { readonly allocationId: bigint; readonly cgroupId: bigint };
      readonly group: { readonly allocationId: bigint; readonly cgroupId: bigint } }
  | { readonly kind: "legacy-native" }
  | { readonly kind: "historical-trace" };

export type BufferProgress =
  | { readonly kind: "select-vector"; readonly ring: bigint; readonly group: number;
      readonly requested: bigint; readonly count: number; readonly address: bigint; readonly length: number; readonly id: number }
  | { readonly kind: "select"; readonly ring: bigint; readonly group: number;
      readonly requested: number; readonly count: number; readonly address: bigint; readonly length: number; readonly id: number }
  | { readonly kind: "provide"; readonly ring: bigint; readonly group: number;
      readonly count: number; readonly provided: number; readonly address: bigint; readonly length: number; readonly first: number;
      readonly allocationOrigin: ProvidedAllocationOrigin }
  | { readonly kind: "remove"; readonly ring: bigint; readonly group: number;
      readonly requested: number; readonly removed: number };

export function decodeBufferProgress(bytes: Uint8Array, view: DataView, offset: number, version: number): BufferProgress | undefined {
  const tag = view.getUint8(offset + 584);
  if (tag === 0) {
    if (bytes.subarray(offset + 585, offset + 624).some(byte => byte !== 0)) throw malformed();
    return undefined;
  }
  const group = view.getUint16(offset + 586, true), count = view.getUint32(offset + 588, true);
  const completed = view.getUint32(offset + 592, true), length = view.getUint32(offset + 596, true);
  const address = view.getBigUint64(offset + 600, true), first = view.getUint16(offset + 608, true);
  const ring = view.getBigUint64(offset + 616, true), opcode = view.getUint8(offset + 232);
  const completion = view.getUint8(offset + 234), outcome = view.getUint8(offset + 120);
  const result = view.getBigInt64(offset + 112, true);
  if (ring === 0n || ring === 0xffff_ffff_ffff_ffffn || bytes[offset + 585] !== 0
    || bytes.subarray(offset + (version >= 43 && tag === 1 ? 611 : 610), offset + 616).some(byte => byte !== 0)) throw malformed();
  if (tag === 4) {
    const requested = view.getBigUint64(offset + 588, true);
    const limited = requested === 0n ? length : requested >= 0x7fff_f000n ? 0x7fff_f000 : Number(requested);
    const count = Math.min(length, limited, 0x7fff_f000);
    if (version < 17 || opcode !== 1 || !validSelection(version, completion, outcome, result, address, length, count)) throw malformed();
    return { kind: "select-vector", ring, group, requested, count, address, length, id: first };
  }
  if (tag === 3) {
    const effective = Math.min(length, count === 0 ? length : count, 0x7fff_f000);
    if (version < 16 || opcode !== 22 || completed !== effective
      || !validSelection(version, completion, outcome, result, address, length, completed)) throw malformed();
    return { kind: "select", ring, group, requested: count, count: completed, address, length, id: first };
  }
  if (count === 0 || count > 65536 || completed > count) throw malformed();
  if (tag === 1) {
    if (opcode !== 31 || completion === 3 || completion === 4 || outcome !== 0 || result !== 0n
      || completed === 0 || completed > Math.min(count, 65535) || length === 0 || first + count > 65536
      || address + BigInt(length) * BigInt(count) > (1n << 47n) - (version >= 43 ? 4096n : 0n)) throw malformed();
    return { kind: "provide", ring, group, count, provided: completed, address, length, first,
      allocationOrigin: decodeAllocationOrigin(bytes, view, offset, version) };
  }
  if (tag !== 2 || opcode !== 32 || length !== 0 || address !== 0n || first !== 0
    || completion === 3 || (completion === 4
      ? outcome !== 2 || result !== 0n || completed === 0 || completed === count
      : outcome !== 0 || result !== BigInt(completed))) throw malformed();
  return { kind: "remove", ring, group, requested: count, removed: completed };
}

function decodeAllocationOrigin(bytes: Uint8Array, view: DataView, at: number, version: number): ProvidedAllocationOrigin {
  if (version < 43) return { kind: "historical-trace" };
  const tag = bytes[at + 610], allocationId = view.getBigUint64(at + 960, true);
  const cgroupId = view.getBigUint64(at + 968, true), groupAllocationId = view.getBigUint64(at + 976, true);
  const groupCgroupId = view.getBigUint64(at + 984, true);
  if (tag === 2 && allocationId === 0n && cgroupId === 0n && groupAllocationId === 0n && groupCgroupId === 0n) return { kind: "legacy-native" };
  if (tag !== 1 || allocationId === 0n || cgroupId === 0n || groupAllocationId === 0n || groupCgroupId === 0n
    || allocationId === groupAllocationId) throw malformed();
  return { kind: "recorded", run: { allocationId, cgroupId },
    group: { allocationId: groupAllocationId, cgroupId: groupCgroupId } };
}

function validSelection(version: number, completion: number, outcome: number, result: bigint, address: bigint, length: number, count: number): boolean {
  return length > 0 && count > 0 && address + BigInt(length) <= 1n << 47n && completion !== 4
    && (completion === 3 || version >= 19 && completion === 6 ? outcome === 2 && result === 0n && address !== 0n
      : outcome === 0 && result <= BigInt(count) && result >= -4095n);
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace buffer progress is malformed");
}
