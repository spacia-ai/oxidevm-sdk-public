/** Exact state derived from the ring's existing FIFO and memory allocation owner. */
export interface ProvidedBufferRetirementFields {
  readonly groupId: number;
  readonly firstId: number;
  readonly address: bigint;
  readonly length: number;
  readonly count: number;
  readonly runsBefore: number;
  readonly buffersBefore: number;
  readonly groupsBefore: number;
  readonly metadataAllocationId: bigint;
  readonly allocationCgroupId: bigint;
}

type Common = Pick<ProvidedBufferRetirementFields, "groupId" | "groupsBefore" | "metadataAllocationId" | "allocationCgroupId">;
export type ProvidedBufferRetirement =
  | ({ readonly kind: "provided-buffers"; readonly phase: "provided-run" } & ProvidedBufferRetirementFields)
  | ({ readonly kind: "provided-buffers"; readonly phase: "provided-group" } & Common);

/** Undefined leaves the enclosing wire owner responsible for its protocol error. */
export function decodeProvidedBufferRetirement(phase: number, raw: ProvidedBufferRetirementFields): ProvidedBufferRetirement | undefined {
  const { groupId, groupsBefore, metadataAllocationId, allocationCgroupId } = raw;
  if (!uint(groupId, 65535) || !uint(groupsBefore, 65536) || groupsBefore === 0
    || metadataAllocationId <= 0n || metadataAllocationId > 0xffff_ffff_ffff_ffffn
    || allocationCgroupId <= 0n || allocationCgroupId > 0xffff_ffff_ffff_ffffn) return undefined;
  if (phase === 14 && raw.firstId === 0 && raw.address === 0n && raw.length === 0
    && raw.count === 0 && raw.runsBefore === 0 && raw.buffersBefore === 0) {
    return { kind: "provided-buffers", phase: "provided-group", groupId, groupsBefore,
      metadataAllocationId, allocationCgroupId };
  }
  if (phase !== 13 || !uint(raw.firstId, 65535) || !uint(raw.length, 0xffff_ffff) || raw.length === 0
    || !uint(raw.buffersBefore, 65535) || !uint(raw.count, raw.buffersBefore) || raw.count === 0
    || !uint(raw.runsBefore, raw.buffersBefore) || raw.runsBefore === 0
    || raw.firstId + raw.count > 65536 || raw.address < 0n
    || raw.address + BigInt(raw.length) * BigInt(raw.count) > (1n << 47n) - 4096n) return undefined;
  return { kind: "provided-buffers", phase: "provided-run", ...raw };
}

function uint(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
