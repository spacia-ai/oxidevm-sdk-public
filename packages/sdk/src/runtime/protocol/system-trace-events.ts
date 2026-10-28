import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import {
  JIT_DISPATCH_TABLE_ENTRIES,
  JIT_REGION_MAX_INSTRUCTIONS,
  MAX_JIT_MODULE_BYTES,
  MAX_LINKED_JIT_MEMBERS,
} from "../jit-cache.js";
import { type CoreProbeExit } from "./core.js";
import {
  finiteNonnegativeNumber,
  nonnegativeBigint,
} from "./decoders.js";
import {
  type SystemTraceEvent,
  type SystemTraceInstruction,
  type SystemTraceJitArtifact,
  type SystemTraceSnapshot,
} from "./system.js";

import {
  decodeSystemTraceCpu,
  decodeSystemTraceJitContext,
} from "./system-trace-state.js";

export function decodeSystemTraceEvent(
  value: unknown,
  index: number,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceEvent {
  const event = record(value, `system trace event ${String(index)}`);
  const kind = string(event["kind"], "system trace event kind");
  const baseKeys = ["kind", "sequence", "workerTimestamp"] as const;
  const sequence = integer(event["sequence"], "system trace sequence", 1);
  const workerTimestamp = finiteNonnegativeNumber(
    event["workerTimestamp"],
    "system trace worker timestamp",
  );
  if (kind === "compile") {
    exactKeys(event, [
      ...baseKeys,
      "startRip",
      "cacheKey",
      "dispatchSlot",
      "moduleBytes",
      "compileMilliseconds",
      "instructions",
    ]);
    return {
      kind,
      sequence,
      workerTimestamp,
      startRip: nonnegativeBigint(event["startRip"], "compiled trace RIP"),
      cacheKey: nonnegativeBigint(event["cacheKey"], "compiled trace cache key"),
      dispatchSlot: integer(
        event["dispatchSlot"],
        "compiled trace dispatch slot",
        0,
        JIT_DISPATCH_TABLE_ENTRIES - 1,
      ),
      moduleBytes: integer(
        event["moduleBytes"],
        "compiled trace module bytes",
        1,
        MAX_JIT_MODULE_BYTES,
      ),
      compileMilliseconds: finiteNonnegativeNumber(
        event["compileMilliseconds"],
        "compiled trace latency",
      ),
      instructions: decodeSystemTraceInstructions(event["instructions"], schemaVersion),
    };
  }
  if (kind === "jit") {
    exactKeys(event, [
      ...baseKeys,
      "before",
      "after",
      "cacheKey",
      "cacheHit",
      "dispatchSlot",
      "lastDispatchSlot",
      "budget",
      "steps",
      "durationMilliseconds",
      "exit",
      "instructions",
      "contextBefore",
      "contextBoundary",
      "contextAfter",
      ...(schemaVersion >= 33 ? ["artifact"] as const : []),
    ]);
    return {
      kind,
      sequence,
      workerTimestamp,
      before: decodeSystemTraceCpu(
        event["before"],
        "JIT trace initial state",
        schemaVersion,
      ),
      after: decodeSystemTraceCpu(
        event["after"],
        "JIT trace final state",
        schemaVersion,
      ),
      cacheKey: nonnegativeBigint(event["cacheKey"], "JIT trace cache key"),
      cacheHit: boolean(event["cacheHit"], "JIT trace cache hit"),
      dispatchSlot: integer(
        event["dispatchSlot"],
        "JIT trace dispatch slot",
        0,
        JIT_DISPATCH_TABLE_ENTRIES - 1,
      ),
      lastDispatchSlot: decodeOptionalDispatchSlot(event["lastDispatchSlot"]),
      budget: integer(event["budget"], "JIT trace budget", 1),
      steps: nonnegativeBigint(event["steps"], "JIT trace steps"),
      durationMilliseconds: finiteNonnegativeNumber(
        event["durationMilliseconds"],
        "JIT trace duration",
      ),
      exit: decodeJitTraceExit(event["exit"], schemaVersion),
      instructions: decodeSystemTraceInstructions(event["instructions"], schemaVersion),
      contextBefore: decodeSystemTraceJitContext(
        event["contextBefore"],
        "JIT context before execution",
      ),
      contextBoundary: decodeSystemTraceJitContext(
        event["contextBoundary"],
        "JIT context at the Wasm boundary",
      ),
      contextAfter: decodeSystemTraceJitContext(
        event["contextAfter"],
        "JIT context after commit",
      ),
      ...(schemaVersion >= 33
        ? { artifact: decodeJitArtifact(event["artifact"], schemaVersion) }
        : {}),
    };
  }
  if (kind === "interpreter") {
    exactKeys(event, [
      ...baseKeys,
      "before",
      "after",
      "budget",
      "steps",
      "durationMilliseconds",
      "reason",
      "exit",
    ]);
    return {
      kind,
      sequence,
      workerTimestamp,
      before: decodeSystemTraceCpu(
        event["before"],
        "interpreter trace initial state",
        schemaVersion,
      ),
      after: decodeSystemTraceCpu(
        event["after"],
        "interpreter trace final state",
        schemaVersion,
      ),
      budget: integer(event["budget"], "interpreter trace budget", 1),
      steps: nonnegativeBigint(event["steps"], "interpreter trace steps"),
      durationMilliseconds: finiteNonnegativeNumber(
        event["durationMilliseconds"],
        "interpreter trace duration",
      ),
      reason: decodeInterpreterTraceReason(event["reason"]),
      exit: decodeCoreProbeExitKind(event["exit"]),
    };
  }
  throw new VMError(
    "PROTOCOL_ERROR",
    `unknown system trace event ${kind}`,
  );
}

/** Decodes a JIT event's artifact; schema 45 adds members of linked batches. */
export function decodeJitArtifact(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceJitArtifact {
  const artifact = record(value, "JIT trace artifact");
  const kind = string(artifact["kind"], "JIT trace artifact kind");
  if (kind === "dynamic") {
    exactKeys(artifact, ["kind"]);
    return { kind };
  }
  if (kind === "linked" && schemaVersion >= 45) {
    exactKeys(artifact, ["kind", "batch", "memberIndex", "members"]);
    const members = integer(
      artifact["members"],
      "linked JIT trace members",
      2,
      MAX_LINKED_JIT_MEMBERS,
    );
    return {
      kind,
      batch: integer(artifact["batch"], "linked JIT trace batch", 1),
      memberIndex: integer(artifact["memberIndex"], "linked JIT trace member", 0, members - 1),
      members,
    };
  }
  if (kind !== "aot") throw new VMError("PROTOCOL_ERROR", "JIT trace artifact kind is invalid");
  exactKeys(artifact, [
    "kind", "packSha256", "memberIndex", "memberEntryOffset", "imageBase", "codePages",
  ]);
  const packSha256 = string(artifact["packSha256"], "AOT trace pack digest");
  if (!/^[0-9a-f]{64}$/u.test(packSha256) || !Array.isArray(artifact["codePages"]) || artifact["codePages"].length > 3) {
    throw new VMError("PROTOCOL_ERROR", "AOT trace artifact identity is invalid");
  }
  return {
    kind,
    packSha256,
    memberIndex: integer(artifact["memberIndex"], "AOT trace member index", 0, 255),
    memberEntryOffset: nonnegativeBigint(artifact["memberEntryOffset"], "AOT trace member offset"),
    imageBase: nonnegativeBigint(artifact["imageBase"], "AOT trace image base"),
    codePages: artifact["codePages"].map((value, index) => {
      const page = record(value, `AOT trace code page ${index}`);
      exactKeys(page, ["linear", "physical", "generation", "globalSupervisor"]);
      return {
        linear: nonnegativeBigint(page["linear"], "AOT trace linear page"),
        physical: nonnegativeBigint(page["physical"], "AOT trace physical page"),
        generation: nonnegativeBigint(page["generation"], "AOT trace page generation"),
        globalSupervisor: boolean(page["globalSupervisor"], "AOT trace global page"),
      };
    }),
  };
}

function decodeJitTraceExit(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): Extract<SystemTraceEvent, { readonly kind: "jit" }>["exit"] {
  const exit = string(value, "JIT trace exit");
  switch (exit) {
    case "performance-overflow-boundary":
      if (schemaVersion < 46) throw new VMError("PROTOCOL_ERROR", "PMU boundary is unavailable in this trace version");
      return exit;
    case "continue":
    case "guard":
    case "budget":
    case "halted":
    case "fault":
      return exit;
    default:
      throw new VMError("PROTOCOL_ERROR", "JIT trace exit is invalid");
  }
}

function decodeOptionalDispatchSlot(value: unknown): number | null {
  return value === null
    ? null
    : integer(
        value,
        "JIT trace final dispatch slot",
        0,
        JIT_DISPATCH_TABLE_ENTRIES - 1,
      );
}

function decodeInterpreterTraceReason(
  value: unknown,
): Extract<SystemTraceEvent, { readonly kind: "interpreter" }>["reason"] {
  const reason = string(value, "interpreter trace reason");
  switch (reason) {
    case "admission":
    case "code-budget":
    case "compiling":
    case "degraded":
    case "guard":
    case "quarantine":
      return reason;
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        "interpreter trace reason is invalid",
      );
  }
}

function decodeCoreProbeExitKind(value: unknown): CoreProbeExit["kind"] {
  const exit = string(value, "interpreter trace exit");
  switch (exit) {
    case "halted":
    case "step-limit":
    case "exception":
    case "reset":
      return exit;
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        "interpreter trace exit is invalid",
      );
  }
}

function decodeSystemTraceInstructions(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): readonly SystemTraceInstruction[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > JIT_REGION_MAX_INSTRUCTIONS
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace instruction map is invalid",
    );
  }
  return value.map((entry, index) => {
    const instruction = record(
      entry,
      `system trace instruction ${String(index)}`,
    );
    exactKeys(
      instruction,
      schemaVersion >= 33
        ? ["rip", "semantic", "retired", "instructionForm"]
        : ["rip", "semantic", "retired"],
    );
    return {
      rip: nonnegativeBigint(instruction["rip"], "trace instruction RIP"),
      semantic: integer(
        instruction["semantic"],
        "trace instruction semantic",
        0,
        0xffff_ffff,
      ),
      retired: integer(
        instruction["retired"],
        "trace instruction retired count",
        1,
        255,
      ),
      instructionForm: schemaVersion >= 33 && instruction["instructionForm"] !== null
        ? integer(instruction["instructionForm"], "trace instruction form", 0, 0xffff)
        : null,
    };
  });
}
