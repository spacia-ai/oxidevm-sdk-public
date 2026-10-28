import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";

export type DoctorCheck = "secure-context" | "cross-origin-isolation" | "wasm-features" | "worker-load" | "asset-integrity" | "wasm-mime" | "content-security-policy" | "storage" | "preview-origin";
export interface DoctorReport {
  readonly result: "passed" | "failed";
  readonly url: string;
  readonly checks: readonly ({ readonly check: DoctorCheck; readonly status: "passed" } | { readonly check: DoctorCheck; readonly status: "failed"; readonly message: string } | { readonly check: "preview-origin"; readonly status: "not-configured" })[];
}
export const DOCTOR_CHECKS: readonly DoctorCheck[] = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage", "preview-origin"];

function text(value: unknown): string {
  const result = string(value, "doctor text");
  if (result.length === 0 || result.length > 8192) throw new VMError("PROTOCOL_ERROR", "invalid doctor text");
  for (let offset = 0; offset < result.length; offset++) {
    const code = result.charCodeAt(offset);
    if (code < 9 || code === 11 || code === 12 || code >= 14 && code <= 31) throw new VMError("PROTOCOL_ERROR", "invalid doctor text");
  }
  return result;
}
export function decodeDoctorReport(value: unknown): DoctorReport {
  const input = record(value, "doctor report"); exactKeys(input, ["result", "url", "checks"]);
  const url = new URL(text(input["url"]));
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") throw new VMError("PROTOCOL_ERROR", "invalid doctor URL");
  if (input["result"] !== "passed" && input["result"] !== "failed" || !Array.isArray(input["checks"]) || input["checks"].length !== DOCTOR_CHECKS.length) throw new VMError("PROTOCOL_ERROR", "incomplete doctor report");
  const checks: DoctorReport["checks"] = Array.from<unknown>(input["checks"]).map(value => {
    const item = record(value, "doctor check"); let check: DoctorCheck | undefined;
    for (const known of DOCTOR_CHECKS) if (known === item["check"]) check = known;
    if (check === undefined) throw new VMError("PROTOCOL_ERROR", "unknown doctor check");
    if (item["status"] === "passed") { exactKeys(item, ["check", "status"]); return { check, status: "passed" }; }
    if (item["status"] === "failed") { exactKeys(item, ["check", "status", "message"]); return { check, status: "failed", message: text(item["message"]) }; }
    exactKeys(item, ["check", "status"]);
    if (check !== "preview-origin" || item["status"] !== "not-configured") throw new VMError("PROTOCOL_ERROR", "mandatory doctor check cannot be omitted");
    return { check, status: "not-configured" };
  });
  if (new Set(checks.map(item => item.check)).size !== checks.length || (input["result"] === "failed") !== checks.some(item => item.status === "failed")) throw new VMError("PROTOCOL_ERROR", "contradictory doctor report");
  return { result: input["result"], url: url.href, checks };
}
