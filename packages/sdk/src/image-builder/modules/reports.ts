import { boolean, exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { decodeSHA256 } from "../../values.js";
import { decoding, invalid } from "../../wasm/decode-support.js";
import type { WasmReport } from "../../wasm/inspect-types.js";
import { decodeCommands } from "../../wasm/manifest-parts.js";
import { DOCTOR_CHECKS, type WasmDoctorEntry, type WasmDoctorReport } from "./doctor.js";

/** How the person's agreement was obtained for a `wasm add`. */
export type AddConsent = "none-needed" | "trusted-source" | "approved";

export interface WasmAddResult {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly release: string;
  readonly status: "added" | "updated" | "unchanged";
  readonly consent: AddConsent;
  readonly license: { readonly spdx: string; readonly copyleft: boolean };
  /** Host capabilities the module is granted. */
  readonly capabilities: readonly string[];
  /** The commands the module declares, run as `/usr/local/bin/<name>` once an application turns them on; absent when it declares none. */
  readonly commands?: readonly string[];
  /** Authority this release asks for that the installed one did not, and the reverse. */
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly generatedFile: string;
}

export interface WasmStageResult {
  readonly modules: readonly { readonly id: string; readonly release: string; readonly rebuilt: boolean }[];
  readonly vendored: readonly string[];
  readonly removed: readonly string[];
  readonly generatedFile: string;
}

export interface WasmInspectResult extends WasmReport {
  readonly file: string;
}

function strings(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new VMError("PROTOCOL_ERROR", `${label} must be a bounded array`);
  return Array.from<unknown>(value).map(item => string(item, label));
}
function choice<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const found = allowed.find(item => item === value);
  if (found === undefined) throw new VMError("PROTOCOL_ERROR", `${label} must be one of ${allowed.join(", ")}`);
  return found;
}

export function decodeWasmAddResult(value: unknown): WasmAddResult {
  return decoding("wasm add result", () => {
    const input = record(value, "wasm add result");
    exactKeys(input, ["id", "version", "source", "release", "status", "consent", "license", "capabilities", "added", "removed", "generatedFile"], ["commands"]);
    const license = record(input["license"], "license");
    exactKeys(license, ["spdx", "copyleft"]);
    return {
      id: string(input["id"], "id"), version: string(input["version"], "version"), source: string(input["source"], "source"), release: decodeSHA256(input["release"], "release"),
      status: choice(input["status"], "status", ["added", "updated", "unchanged"]), consent: choice(input["consent"], "consent", ["none-needed", "trusted-source", "approved"]),
      license: { spdx: string(license["spdx"], "license"), copyleft: boolean(license["copyleft"], "copyleft") },
      capabilities: strings(input["capabilities"], "capabilities", 64), ...(input["commands"] === undefined ? {} : { commands: decodeCommands(input["commands"]) }),
      added: strings(input["added"], "added", 256), removed: strings(input["removed"], "removed", 256), generatedFile: string(input["generatedFile"], "generatedFile"),
    };
  });
}

export function decodeWasmStageResult(value: unknown): WasmStageResult {
  return decoding("wasm stage result", () => {
    const input = record(value, "wasm stage result");
    exactKeys(input, ["modules", "vendored", "removed", "generatedFile"]);
    if (!Array.isArray(input["modules"]) || input["modules"].length > 64) invalid("modules", "must be a bounded array");
    const modules = Array.from<unknown>(input["modules"]).map(entry => {
      const item = record(entry, "staged module");
      exactKeys(item, ["id", "release", "rebuilt"]);
      return { id: string(item["id"], "id"), release: decodeSHA256(item["release"], "release"), rebuilt: boolean(item["rebuilt"], "rebuilt") };
    });
    return { modules, vendored: strings(input["vendored"], "vendored", 64), removed: strings(input["removed"], "removed", 256), generatedFile: string(input["generatedFile"], "generatedFile") };
  });
}

export function decodeWasmDoctorReport(value: unknown): WasmDoctorReport {
  return decoding("wasm doctor report", () => {
    const input = record(value, "wasm doctor report");
    exactKeys(input, ["result", "modules", "checks"]);
    if (!Array.isArray(input["checks"]) || input["checks"].length !== DOCTOR_CHECKS.length) invalid("checks", "must list every check once");
    const checks: WasmDoctorEntry[] = Array.from<unknown>(input["checks"]).map(entry => {
      const item = record(entry, "doctor check");
      const check = choice(item["check"], "check", DOCTOR_CHECKS), status = choice(item["status"], "status", ["passed", "failed", "note"]);
      if (status === "passed") { exactKeys(item, ["check", "status"]); return { check, status }; }
      exactKeys(item, ["check", "status", "message"]);
      return { check, status, message: string(item["message"], "message") };
    });
    if (new Set(checks.map(item => item.check)).size !== DOCTOR_CHECKS.length) invalid("checks", "must list every check once");
    const result = choice(input["result"], "result", ["passed", "failed"]);
    if ((result === "failed") !== checks.some(item => item.status === "failed")) invalid("result", "contradicts its checks");
    return { result, modules: strings(input["modules"], "modules", 64), checks };
  });
}

export function decodeWasmInspectResult(value: unknown): WasmInspectResult {
  return decoding("wasm inspect result", () => {
    const input = record(value, "wasm inspect result");
    exactKeys(input, ["file", "kind", "bytes", "imports", "exports", "customSections", "memories", "abi", "evidence", "targetFeatures"]);
    if (!Array.isArray(input["imports"]) || !Array.isArray(input["memories"])) invalid("report", "has malformed lists");
    return {
      file: string(input["file"], "file"), kind: choice(input["kind"], "kind", ["module", "component"]), bytes: integer(input["bytes"], "bytes", 0, 2 ** 31),
      imports: Array.from<unknown>(input["imports"]).map(entry => { const item = record(entry, "import"); exactKeys(item, ["module", "names"]); return { module: string(item["module"], "module"), names: integer(item["names"], "names", 0, 2 ** 20) }; }),
      exports: strings(input["exports"], "exports", 200), customSections: strings(input["customSections"], "customSections", 64),
      memories: Array.from<unknown>(input["memories"]).map(entry => {
        const item = record(entry, "memory");
        exactKeys(item, ["minPages", "maxPages", "shared", "memory64"]);
        return { minPages: integer(item["minPages"], "minPages", 0, 2 ** 32), maxPages: item["maxPages"] === null ? null : integer(item["maxPages"], "maxPages", 0, 2 ** 32), shared: boolean(item["shared"], "shared"), memory64: boolean(item["memory64"], "memory64") };
      }),
      abi: choice(input["abi"], "abi", ["wasi", "component", "emscripten", "bindgen", "raw"]), evidence: strings(input["evidence"], "evidence", 16), targetFeatures: boolean(input["targetFeatures"], "targetFeatures"),
    };
  });
}
