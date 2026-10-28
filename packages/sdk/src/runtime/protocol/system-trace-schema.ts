import { integer } from "../decode.ts";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "./common.ts";
import type { SystemTraceSnapshot } from "./system.js";

const SYSTEM_TRACE_SCHEMA_VERSIONS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 50, 51, 52, 53, SYSTEM_TRACE_SCHEMA_VERSION,
] as const satisfies readonly SystemTraceSnapshot["schemaVersion"][];

export { SYSTEM_TRACE_SCHEMA_VERSION };

export function decodeSystemTraceSchemaVersion(
  value: unknown,
): SystemTraceSnapshot["schemaVersion"] {
  const raw = integer(
    value,
    "system trace schema version",
    SYSTEM_TRACE_SCHEMA_VERSIONS[0],
    SYSTEM_TRACE_SCHEMA_VERSION,
  );
  const version = SYSTEM_TRACE_SCHEMA_VERSIONS.find(version => version === raw);
  if (version === undefined) {
    throw new RangeError("system trace schema version is unsupported");
  }
  return version;
}
