import type { CoreException, CoreExceptionClass, CoreProbeExit } from "../protocol.ts";
import { BinaryCursor, fault } from "./cursor.ts";
import { recordPayload } from "./binary.ts";

const RESULT_PAYLOAD_LENGTH = 36;

export type CoreEntropyFailureReason = "input-too-large" | "invalid-request" | "invalid-sequence" | "replay-mismatch" | "replay-exhausted" | "sequence-exhausted";
export type CoreInternalFailure =
  | { readonly kind: "unsupported-semantic" | "unsupported-profile" | "unsupported-system-management-interrupt" | "unexpected-adapter-exit" }
  | { readonly kind: "entropy-replay"; readonly reason: CoreEntropyFailureReason };

export type CoreRunExit =
  | CoreProbeExit
  | { readonly kind: "adapter-exit"; readonly steps: bigint }
  | { readonly kind: "internal-failure"; readonly steps: bigint; readonly failure?: CoreInternalFailure };

export function decodeRunResult(bytes: Uint8Array): CoreRunExit {
  const header = new BinaryCursor(bytes);
  header.u32();
  const version = header.u16();
  if (version !== 1 && version !== 2) throw fault("unsupported run-result record version");
  const cursor = recordPayload(
    bytes,
    "OXRR",
    version,
    RESULT_PAYLOAD_LENGTH,
  );
  const kind = cursor.u8();
  cursor.zero(3, "run-result reserved field");
  const steps = cursor.u64();

  switch (kind) {
    case 0:
    case 1:
      cursor.zero(24, "unexpected run-result payload");
      cursor.finish("run-result");
      return { kind: kind === 0 ? "halted" : "step-limit", steps };
    case 2: {
      const exception = decodeException(cursor);
      cursor.finish("run-result");
      return { kind: "exception", steps, exception };
    }
    case 3: {
      const reason = cursor.u8();
      cursor.zero(23, "reset reserved field");
      cursor.finish("run-result");
      if (reason !== 0 && reason !== 1) {
        throw fault(`unknown reset reason ${reason}`);
      }
      return {
        kind: "reset",
        steps,
        reason: reason === 0 ? "triple-fault" : "external-reset",
      };
    }
    case 4:
      cursor.zero(24, "adapter-exit reserved field");
      cursor.finish("run-result");
      return { kind: "adapter-exit", steps };
    case 5: {
      const failure = version === 2 ? decodeInternalFailure(cursor) : undefined;
      cursor.zero(version === 2 ? 22 : 24, "internal-exit reserved field");
      cursor.finish("run-result");
      return { kind: "internal-failure", steps, ...(failure === undefined ? {} : { failure }) };
    }
    default:
      throw fault(`unknown core exit ${kind}`);
  }
}

function decodeInternalFailure(cursor: BinaryCursor): CoreInternalFailure {
  const kind = cursor.u8();
  const detail = cursor.u8();
  if (kind !== 5 && detail !== 0) throw fault("unexpected internal-failure detail");
  switch (kind) {
    case 1: return { kind: "unsupported-semantic" };
    case 2: return { kind: "unsupported-profile" };
    case 3: return { kind: "unsupported-system-management-interrupt" };
    case 4: return { kind: "unexpected-adapter-exit" };
    case 5: {
      const reasons: readonly CoreEntropyFailureReason[] = ["input-too-large", "invalid-request", "invalid-sequence", "replay-mismatch", "replay-exhausted", "sequence-exhausted"];
      const reason = reasons[detail - 1];
      if (reason === undefined) throw fault("unknown entropy replay failure");
      return { kind: "entropy-replay", reason };
    }
    default: throw fault("unknown internal failure");
  }
}

function decodeException(cursor: BinaryCursor): CoreException {
  const vector = cursor.u8();
  const exceptionClass = decodeExceptionClass(cursor.u8());
  const flags = cursor.u8();
  if ((flags & ~3) !== 0) {
    throw fault("run-result has invalid exception flags");
  }
  if (cursor.u8() !== 0) {
    throw fault("run-result has a nonzero exception reserved field");
  }
  const errorCode = cursor.u32();
  const faultAddress = cursor.u64();
  const instructionRip = cursor.u64();
  if ((flags & 1) === 0 && errorCode !== 0) {
    throw fault("run-result has an unflagged error code");
  }
  if ((flags & 2) === 0 && faultAddress !== 0n) {
    throw fault("run-result has an unflagged fault address");
  }
  return {
    vector: { name: vectorName(vector), number: vector },
    class: exceptionClass,
    instructionRip,
    ...((flags & 1) === 0 ? {} : { errorCode }),
    ...((flags & 2) === 0 ? {} : { faultAddress }),
  };
}

function decodeExceptionClass(value: number): CoreExceptionClass {
  switch (value) {
    case 0:
      return "fault";
    case 1:
      return "trap";
    case 2:
      return "abort";
    case 3:
      return "interrupt";
    default:
      throw fault(`invalid exception class ${value}`);
  }
}

function vectorName(vector: number): string {
  const names: readonly string[] = [
    "#DE",
    "#DB",
    "NMI",
    "#BP",
    "#OF",
    "#BR",
    "#UD",
    "#NM",
    "#DF",
    "#9",
    "#TS",
    "#NP",
    "#SS",
    "#GP",
    "#PF",
    "#15",
    "#MF",
    "#AC",
    "#MC",
    "#XM",
    "#VE",
    "#CP",
  ];
  return names[vector] ?? `#${vector}`;
}
