import { boolean, exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeDoctorText } from "./doctor.js";

// The values the frame probe (browser-test/doctor-frame-client.ts) hands the doctor from an application's page. The
// doctor receives them from the page as untrusted values and decodes them here before it reports anything.

/** The `Symbol.for` key under which the frame probe registers its `page` and `frame` functions in the page. */
export const DOCTOR_FRAME_PROBE = "oxidevm.doctor-frame";

/** What the application page itself offers the runtime frame. */
export interface FramePageProbe {
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  /** The WebAssembly and JavaScript features this browser lacks, as `detectBrowserSupport` names them. */
  readonly missingFeatures: readonly string[];
}

/** Whether the runtime frame loaded in the page and accepted it, and the page directive that blocked it, if any. */
export type FrameMountProbe =
  | { readonly kind: "accepted"; readonly engineReleaseId: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string; readonly blockedBy: string | null };

const TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;

function token(value: unknown, label: string): string {
  const result = string(value, label);
  if (!TOKEN.test(result)) throw new VMError("PROTOCOL_ERROR", `invalid ${label}`);
  return result;
}

export function decodeFramePageProbe(value: unknown): FramePageProbe {
  const input = record(value, "frame page probe"); exactKeys(input, ["secureContext", "crossOriginIsolated", "missingFeatures"]);
  const missing = input["missingFeatures"];
  if (!Array.isArray(missing) || missing.length > 16) throw new VMError("PROTOCOL_ERROR", "invalid missing browser features");
  return {
    secureContext: boolean(input["secureContext"], "secure context"), crossOriginIsolated: boolean(input["crossOriginIsolated"], "cross-origin isolation"),
    missingFeatures: Array.from<unknown>(missing).map(feature => token(feature, "browser feature")),
  };
}

export function decodeFrameMountProbe(value: unknown): FrameMountProbe {
  const input = record(value, "frame mount probe");
  if (input["kind"] === "accepted") {
    exactKeys(input, ["kind", "engineReleaseId"]);
    const engineReleaseId = string(input["engineReleaseId"], "engine release");
    if (!/^[0-9a-f]{64}$/u.test(engineReleaseId)) throw new VMError("PROTOCOL_ERROR", "invalid engine release");
    return { kind: "accepted", engineReleaseId };
  }
  if (input["kind"] !== "failed") throw new VMError("PROTOCOL_ERROR", "frame mount probe must be accepted or failed");
  exactKeys(input, ["kind", "code", "message", "blockedBy"]);
  const code = string(input["code"], "error code");
  if (!/^[A-Z][A-Z_]{0,31}$/u.test(code)) throw new VMError("PROTOCOL_ERROR", "invalid error code");
  return { kind: "failed", code, message: decodeDoctorText(input["message"]), blockedBy: input["blockedBy"] === null ? null : token(input["blockedBy"], "blocking directive") };
}
