import { integer } from "../decode.ts";
import type { CoreRuntimeProfile, SystemTraceSnapshot } from "./system.js";

const RECORD_TRACE_VERSIONS = [
  [11, 23], [12, 24], [13, 25], [14, 26], [15, 28], [16, 29],
  [17, 30], [18, 31], [19, 32], [20, 33], [21, 37], [22, 40],
  [23, 41], [24, 43], [25, 44], [26, 45], [27, 48], [28, 49], [29, 50], [30, 52], [31, 53],
] as const satisfies readonly (readonly [CoreRuntimeProfile["recordVersion"], SystemTraceSnapshot["schemaVersion"]])[];

export function coreRecordVersionForTrace(schemaVersion: number): CoreRuntimeProfile["recordVersion"] {
  return RECORD_TRACE_VERSIONS.findLast(([, trace]) => trace <= schemaVersion)?.[0] ?? 11;
}

export function coreTraceVersionForRecord(recordVersion: unknown): SystemTraceSnapshot["schemaVersion"] {
  const version = integer(recordVersion, "core runtime profile record version", 11, Math.max(...RECORD_TRACE_VERSIONS.map(([record]) => record)));
  const found = RECORD_TRACE_VERSIONS.find(([record]) => record === version);
  if (found === undefined) throw new TypeError("unsupported core runtime profile record version");
  return found[1];
}
