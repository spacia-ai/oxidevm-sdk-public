export type TracePartition = "system" | "application" | "shared-library";

const LINUX_SHARED_LIBRARY_BASE = 0x0000_7000_0000_0000n;

export function tracePartition(cpl: number | undefined, rip: bigint): TracePartition {
  if (cpl !== 3) return "system";
  return rip < LINUX_SHARED_LIBRARY_BASE ? "application" : "shared-library";
}

export function tracePartitionCapacity(total: number): number {
  return total < 4 ? 0 : Math.floor(total / 4);
}

export function applicationTraceTailCapacity(reserved: number): number {
  return Math.min(1_024, Math.floor(reserved / 4));
}

export function sampleApplicationTrace(index: number): boolean {
  return index % 16 === 0;
}
