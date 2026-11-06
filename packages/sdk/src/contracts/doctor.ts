import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";

/** `lock` compares the project's `oxidevm.lock.json` with the installed SDK; it runs in Node, not in the page. */
export type DoctorCheck = "secure-context" | "cross-origin-isolation" | "wasm-features" | "worker-load" | "asset-integrity" | "wasm-mime" | "content-security-policy" | "storage" | "preview-origin" | "lock";
/**
 * The runtime the doctor checked (engine ADR 0021): the application's own self-hosted assets at `assets`, or the hosted
 * runtime frame of this SDK release at `frame`.
 */
export type DoctorHosting = { readonly kind: "self-hosted"; readonly assets: string } | { readonly kind: "frame"; readonly frame: string };
/** With frame hosting the runtime's workers and storage live inside the runtime frame, not in the application. */
export type FrameOwnedCheck = "worker-load" | "storage";
export interface DoctorReport {
  readonly result: "passed" | "failed";
  readonly url: string;
  readonly hosting: DoctorHosting;
  readonly checks: readonly ({ readonly check: DoctorCheck; readonly status: "passed" } | { readonly check: DoctorCheck; readonly status: "failed"; readonly message: string } | { readonly check: "preview-origin" | "lock"; readonly status: "not-configured" } | { readonly check: FrameOwnedCheck; readonly status: "not-applicable" })[];
}
export const DOCTOR_CHECKS: readonly DoctorCheck[] = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage", "preview-origin", "lock"];
export const FRAME_OWNED_CHECKS: readonly FrameOwnedCheck[] = ["worker-load", "storage"];
export function isFrameOwnedCheck(check: DoctorCheck): check is FrameOwnedCheck { return FRAME_OWNED_CHECKS.some(owned => owned === check); }

/** Text a doctor report may carry: bounded, without control characters other than tab and newlines. */
export function decodeDoctorText(value: unknown): string {
  const result = string(value, "doctor text");
  if (result.length === 0 || result.length > 8192) throw new VMError("PROTOCOL_ERROR", "invalid doctor text");
  for (let offset = 0; offset < result.length; offset++) {
    const code = result.charCodeAt(offset);
    if (code < 9 || code === 11 || code === 12 || code >= 14 && code <= 31) throw new VMError("PROTOCOL_ERROR", "invalid doctor text");
  }
  return result;
}
function httpURL(value: unknown, what: string): string {
  let url: URL;
  try { url = new URL(decodeDoctorText(value)); } catch { throw new VMError("PROTOCOL_ERROR", `invalid doctor ${what}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") throw new VMError("PROTOCOL_ERROR", `invalid doctor ${what}`);
  return url.href;
}
function decodeHosting(value: unknown): DoctorHosting {
  const input = record(value, "doctor hosting");
  if (input["kind"] === "self-hosted") { exactKeys(input, ["kind", "assets"]); return { kind: "self-hosted", assets: httpURL(input["assets"], "asset base") }; }
  if (input["kind"] === "frame") { exactKeys(input, ["kind", "frame"]); return { kind: "frame", frame: httpURL(input["frame"], "runtime frame") }; }
  throw new VMError("PROTOCOL_ERROR", "doctor hosting must be self-hosted or frame");
}
export function decodeDoctorReport(value: unknown): DoctorReport {
  const input = record(value, "doctor report"); exactKeys(input, ["result", "url", "hosting", "checks"]);
  const url = httpURL(input["url"], "URL"), hosting = decodeHosting(input["hosting"]);
  if (input["result"] !== "passed" && input["result"] !== "failed" || !Array.isArray(input["checks"]) || input["checks"].length !== DOCTOR_CHECKS.length) throw new VMError("PROTOCOL_ERROR", "incomplete doctor report");
  const checks: DoctorReport["checks"] = Array.from<unknown>(input["checks"]).map(value => {
    const item = record(value, "doctor check"); let check: DoctorCheck | undefined;
    for (const known of DOCTOR_CHECKS) if (known === item["check"]) check = known;
    if (check === undefined) throw new VMError("PROTOCOL_ERROR", "unknown doctor check");
    if (item["status"] === "passed") { exactKeys(item, ["check", "status"]); return { check, status: "passed" }; }
    if (item["status"] === "failed") { exactKeys(item, ["check", "status", "message"]); return { check, status: "failed", message: decodeDoctorText(item["message"]) }; }
    exactKeys(item, ["check", "status"]);
    if (item["status"] === "not-configured" && (check === "preview-origin" || check === "lock")) return { check, status: "not-configured" };
    // Only a frame-hosted report leaves the checks of what runs inside the runtime frame to that frame.
    if (item["status"] === "not-applicable" && hosting.kind === "frame" && isFrameOwnedCheck(check)) return { check, status: "not-applicable" };
    throw new VMError("PROTOCOL_ERROR", "mandatory doctor check cannot be omitted");
  });
  if (new Set(checks.map(item => item.check)).size !== checks.length || (input["result"] === "failed") !== checks.some(item => item.status === "failed")) throw new VMError("PROTOCOL_ERROR", "contradictory doctor report");
  return { result: input["result"], url, hosting, checks };
}
