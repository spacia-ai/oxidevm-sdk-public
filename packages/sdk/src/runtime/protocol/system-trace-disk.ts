import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { finiteNonnegativeNumber } from "./decoders.js";
import type { SystemTraceProfile, SystemTraceSnapshot } from "./system.js";

const BASE_KEYS = [
  "enabled",
  "requests",
  "failures",
  "reads",
  "readBytes",
  "writes",
  "writtenBytes",
  "zeroes",
  "zeroedBytes",
  "discards",
  "discardedBytes",
  "flushes",
  "waitMilliseconds",
  "maximumWaitMilliseconds",
] as const;

export function decodeSystemTraceDiskProfile(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceProfile["disk"] {
  const disk = record(value, "system disk profile");
  exactKeys(
    disk,
    schemaVersion >= 20
      ? [
          ...BASE_KEYS,
          "maximumQueueDepth",
          "busyReturns",
          "maximumInFlight",
          "delayedFailures",
          "backendFailures",
          "protocolFailures",
          "timeoutFailures",
          ...(schemaVersion >= 34 ? ["quotaFailures"] as const : []),
        ]
      : BASE_KEYS,
    schemaVersion >= 20 ? ["stickyFailure"] : [],
  );
  const stickyFailure =
    schemaVersion < 20 || disk["stickyFailure"] === undefined
      ? undefined
      : decodeStickyFailure(disk["stickyFailure"], schemaVersion);
  const decoded: SystemTraceProfile["disk"] = {
    enabled: boolean(disk["enabled"], "disk profiling state"),
    requests: integer(disk["requests"], "disk profile requests", 0),
    failures: integer(disk["failures"], "disk profile failures", 0),
    reads: integer(disk["reads"], "disk profile reads", 0),
    readBytes: integer(disk["readBytes"], "disk profile read bytes", 0),
    writes: integer(disk["writes"], "disk profile writes", 0),
    writtenBytes: integer(
      disk["writtenBytes"],
      "disk profile written bytes",
      0,
    ),
    zeroes: integer(disk["zeroes"], "disk profile zeroes", 0),
    zeroedBytes: integer(
      disk["zeroedBytes"],
      "disk profile zeroed bytes",
      0,
    ),
    discards: integer(disk["discards"], "disk profile discards", 0),
    discardedBytes: integer(
      disk["discardedBytes"],
      "disk profile discarded bytes",
      0,
    ),
    flushes: integer(disk["flushes"], "disk profile flushes", 0),
    waitMilliseconds: finiteNonnegativeNumber(
      disk["waitMilliseconds"],
      "disk profile wait duration",
    ),
    maximumWaitMilliseconds: finiteNonnegativeNumber(
      disk["maximumWaitMilliseconds"],
      "disk profile maximum wait",
    ),
    ...(schemaVersion < 20
      ? {}
      : {
          maximumQueueDepth: integer(
            disk["maximumQueueDepth"],
            "disk maximum queue depth",
            0,
            256,
          ),
          busyReturns: integer(disk["busyReturns"], "disk busy returns", 0),
          maximumInFlight: integer(
            disk["maximumInFlight"],
            "disk maximum in-flight requests",
            0,
          ),
          delayedFailures: integer(
            disk["delayedFailures"],
            "disk delayed failures",
            0,
          ),
          backendFailures: integer(
            disk["backendFailures"],
            "disk backend failures",
            0,
          ),
          protocolFailures: integer(
            disk["protocolFailures"],
            "disk protocol failures",
            0,
          ),
          timeoutFailures: integer(
            disk["timeoutFailures"],
            "disk timeout failures",
            0,
          ),
          ...(schemaVersion >= 34
            ? {
                quotaFailures: integer(
                  disk["quotaFailures"],
                  "disk quota failures",
                  0,
                ),
              }
            : {}),
        }),
    ...(stickyFailure === undefined ? {} : { stickyFailure }),
  };
  validateDiskProfile(decoded, schemaVersion);
  return decoded;
}

function decodeStickyFailure(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): NonNullable<SystemTraceProfile["disk"]["stickyFailure"]> {
  const failure = record(value, "disk sticky failure");
  exactKeys(
    failure,
    ["sequence", "reason"],
    schemaVersion >= 30 ? ["operation", "offset", "length"] : [],
  );
  const reason = string(failure["reason"], "disk sticky failure reason");
  if (
    reason !== "backend" &&
    reason !== "protocol" &&
    reason !== "timeout" &&
    (reason !== "quota" || schemaVersion < 34)
  ) {
    throw new VMError("PROTOCOL_ERROR", "disk sticky failure reason is invalid");
  }
  const operation = failure["operation"];
  const hasIdentity =
    operation !== undefined ||
    failure["offset"] !== undefined ||
    failure["length"] !== undefined;
  if (
    hasIdentity &&
    (schemaVersion < 30 ||
      (operation !== "read" &&
        operation !== "write" &&
        operation !== "zero" &&
        operation !== "flush") ||
      failure["offset"] === undefined ||
      failure["length"] === undefined)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "disk sticky failure command identity is invalid",
    );
  }
  const commandIdentity: {
    readonly operation: "read" | "write" | "zero" | "flush";
    readonly offset: number;
    readonly length: number;
  } | undefined =
    operation === "read" ||
    operation === "write" ||
    operation === "zero" ||
    operation === "flush"
      ? {
          operation,
          offset: integer(failure["offset"], "disk sticky failure offset", 0),
          length: integer(failure["length"], "disk sticky failure length", 0),
        }
      : undefined;
  return {
    sequence: integer(failure["sequence"], "disk sticky failure sequence", 1),
    reason,
    ...(commandIdentity === undefined ? {} : commandIdentity),
  };
}

function validateDiskProfile(
  disk: SystemTraceProfile["disk"],
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): void {
  const categorized =
    disk.reads + disk.writes + disk.zeroes + disk.discards + disk.flushes;
  const reasonFailures =
    (disk.backendFailures ?? 0) +
    (disk.protocolFailures ?? 0) +
    (disk.timeoutFailures ?? 0) +
    (disk.quotaFailures ?? 0);
  if (
    disk.failures > disk.requests ||
    categorized > disk.requests ||
    disk.maximumWaitMilliseconds > disk.waitMilliseconds ||
    (schemaVersion >= 20 &&
      ((disk.busyReturns ?? 0) > disk.requests ||
        (disk.delayedFailures ?? 0) > disk.failures ||
        reasonFailures !== disk.failures ||
        (disk.maximumInFlight ?? 0) > disk.reads + disk.flushes))
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system disk profile counters do not agree",
    );
  }
}
