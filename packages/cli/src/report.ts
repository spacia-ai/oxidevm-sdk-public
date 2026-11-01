import { VMError } from "@oxidevm/sdk";
import { decodeBuilderError, decodeImageDigest, decodeImageDistribution, decodeImageInspection, decodeImageTestReport,decodeSnapshotBuildResult,decodeSnapshotTestReport,decodeSnapshotInspectResult, decodeWasmAddResult, decodeWasmBuildResult, decodeWasmDoctorReport, decodeWasmInspectResult, decodeWasmStageResult, decodeWasmTestReport } from "@oxidevm/sdk/image-builder";
import type { CliCommand, CliReport, DoctorCheck, DoctorReport } from "./contracts.js";
import { choice, fields, number, object, text } from "./validation.js";

const commands: readonly CliCommand[] = ["init", "assets install", "doctor", "image init", "image keygen", "image build", "image test", "image inspect", "image pack","snapshot init","snapshot build","snapshot pack","snapshot test","snapshot inspect","wasm add","wasm stage","wasm doctor","wasm inspect","wasm build","wasm release","wasm init","wasm test"];
const doctorChecks: readonly DoctorCheck[] = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage", "preview-origin"];

export function decodeDoctorReport(value: unknown): DoctorReport {
  const input = object(value, "doctor report"); fields(input, ["result", "url", "checks"]);
  const url = new URL(text(input["url"]));
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") throw new VMError("PROTOCOL_ERROR", "invalid doctor URL");
  const result = choice(input["result"], ["passed", "failed"]);
  if (!Array.isArray(input["checks"])) throw new VMError("PROTOCOL_ERROR", "doctor checks must be an array");
  const checks: DoctorReport["checks"] = Array.from<unknown>(input["checks"]).map(value => {
    const item = object(value, "doctor check"); const check = choice(item["check"], doctorChecks);
    if (item["status"] === "passed") { fields(item, ["check", "status"]); return { check, status: "passed" }; }
    if (item["status"] === "failed") { fields(item, ["check", "status", "message"]); return { check, status: "failed", message: text(item["message"]) }; }
    fields(item, ["check", "status"]);
    if (check !== "preview-origin" || item["status"] !== "not-configured") throw new VMError("PROTOCOL_ERROR", "mandatory doctor check cannot be omitted");
    return { check: "preview-origin", status: "not-configured" };
  });
  if (checks.length !== doctorChecks.length || new Set(checks.map(item => item.check)).size !== checks.length || (result === "failed") !== checks.some(item => item.status === "failed")) throw new VMError("PROTOCOL_ERROR", "incomplete or contradictory doctor report");
  return { result, url: url.href, checks };
}

/** Parse external CLI JSON; envelope and command-specific fields are both exact. */
export function decodeCliReport(value: unknown): CliReport {
  const input = object(value, "CLI report");
  if (input["schemaVersion"] !== 2) throw new VMError("PROTOCOL_ERROR", "unsupported CLI report schema");
  if (input["kind"] === "error") {
    fields(input, ["schemaVersion", "kind", "command", "error"]);
    return { schemaVersion: 2, kind: "error", command: input["command"] === null ? null : choice(input["command"], commands), error: decodeBuilderError(input["error"]) };
  }
  fields(input, ["schemaVersion", "kind", "command", "result"]);
  if (input["kind"] !== "result") throw new VMError("PROTOCOL_ERROR", "invalid CLI envelope");
  const command = choice(input["command"], commands); const result = object(input["result"], "CLI result");
  switch (command) {
    case "snapshot init":{
      fields(result,["directory","recipePath","mode","name","files"]);
      if(!Array.isArray(result["files"])||result["files"].length!==6||new Set(result["files"]).size!==6)throw new VMError("PROTOCOL_ERROR","Snapshot scaffold must contain six files");
      return {schemaVersion:2,kind:"result",command,result:{directory:text(result["directory"]),recipePath:text(result["recipePath"]),mode:choice(result["mode"],["system","userspace"]),name:text(result["name"]),files:Array.from<unknown>(result["files"]).map(text)}};
    }
    case "snapshot build":case "snapshot pack":return {schemaVersion:2,kind:"result",command,result:decodeSnapshotBuildResult(result)};
    case "snapshot test":return {schemaVersion:2,kind:"result",command,result:decodeSnapshotTestReport(result)};
    case "snapshot inspect":return {schemaVersion:2,kind:"result",command,result:decodeSnapshotInspectResult(result)};
    case "wasm add": return { schemaVersion: 2, kind: "result", command, result: decodeWasmAddResult(result) };
    case "wasm stage": return { schemaVersion: 2, kind: "result", command, result: decodeWasmStageResult(result) };
    case "wasm doctor": return { schemaVersion: 2, kind: "result", command, result: decodeWasmDoctorReport(result) };
    case "wasm inspect": return { schemaVersion: 2, kind: "result", command, result: decodeWasmInspectResult(result) };
    case "wasm build": return { schemaVersion: 2, kind: "result", command, result: decodeWasmBuildResult(result) };
    case "wasm release": {
      fields(result, ["build", "tag", "steps"]);
      const build = decodeWasmBuildResult(result["build"]), tag = result["tag"] === null ? null : text(result["tag"]);
      if (!Array.isArray(result["steps"]) || result["steps"].length > 32 || (build.result === "failed") !== (tag === null) || (tag === null) !== (result["steps"].length === 0)) throw new VMError("PROTOCOL_ERROR", "a release plan has a tag and steps exactly when the build succeeded");
      return { schemaVersion: 2, kind: "result", command, result: { build, tag, steps: Array.from<unknown>(result["steps"]).map(step => text(step)) } };
    }
    case "wasm test": return { schemaVersion: 2, kind: "result", command, result: decodeWasmTestReport(result) };
    case "wasm init": {
      fields(result, ["directory", "id", "kind", "abi", "files"], ["commands"]);
      if (!Array.isArray(result["files"]) || result["files"].length === 0 || result["files"].length > 64) throw new VMError("PROTOCOL_ERROR", "a module scaffold lists its files");
      const kind = choice(result["kind"], ["command", "service"]), commands = result["commands"];
      // A manifest declares at most sixteen commands, and only a command module declares any.
      if (commands !== undefined && (kind !== "command" || !Array.isArray(commands) || commands.length > 16)) throw new VMError("PROTOCOL_ERROR", "only a command module's scaffold lists commands, at most sixteen");
      return { schemaVersion: 2, kind: "result", command, result: {
        directory: text(result["directory"]), id: text(result["id"]), kind, abi: text(result["abi"]), files: Array.from<unknown>(result["files"]).map(file => text(file)),
        ...(commands === undefined ? {} : { commands: Array.from<unknown>(commands).map(name => text(name)) }),
      } };
    }
    case "init": {
      fields(result, ["directory", "mode", "assets"]);
      return { schemaVersion: 2, kind: "result", command, result: { directory: text(result["directory"]), mode: choice(result["mode"], ["system", "userspace"]), assets: choice(result["assets"], ["installed", "skipped"]) } };
    }
    case "assets install": {
      fields(result, ["publicDir", "files", "referencePath"]);
      return { schemaVersion: 2, kind: "result", command, result: { publicDir: text(result["publicDir"]), files: number(result["files"], 1), referencePath: result["referencePath"] === null ? null : text(result["referencePath"]) } };
    }
    case "doctor": return { schemaVersion: 2, kind: "result", command, result: decodeDoctorReport(result) };
    case "image init": {
      fields(result, ["directory", "recipePath", "mode"]);
      return { schemaVersion: 2, kind: "result", command, result: { directory: text(result["directory"]), recipePath: text(result["recipePath"]), mode: choice(result["mode"], ["system", "userspace"]) } };
    }
    case "image keygen": {
      fields(result, ["privateKeyPath", "publicKeyPath", "keyId"]);
      return { schemaVersion: 2, kind: "result", command, result: { privateKeyPath: text(result["privateKeyPath"]), publicKeyPath: text(result["publicKeyPath"]), keyId: text(result["keyId"]) } };
    }
    case "image build": {
      fields(result, ["mode", "manifestSHA256", "bundleDir", "referencePath", "lockPath", "distribution"]);
      return { schemaVersion: 2, kind: "result", command, result: { mode: choice(result["mode"], ["system", "userspace"]), manifestSHA256: decodeImageDigest(result["manifestSHA256"], "manifest digest"), bundleDir: text(result["bundleDir"]), referencePath: text(result["referencePath"]), lockPath: text(result["lockPath"]), distribution: decodeImageDistribution(result["distribution"]) } };
    }
    case "image test": return { schemaVersion: 2, kind: "result", command, result: decodeImageTestReport(result) };
    case "image inspect": return { schemaVersion: 2, kind: "result", command, result: decodeImageInspection(result) };
    case "image pack": {
      fields(result, ["manifestSHA256", "transportPath", "packCount", "encodedBytes", "decodedBytes"]);
      return { schemaVersion: 2, kind: "result", command, result: {
        manifestSHA256: decodeImageDigest(result["manifestSHA256"], "manifest digest"), transportPath: text(result["transportPath"]),
        packCount: number(result["packCount"], 0), encodedBytes: number(result["encodedBytes"], 0), decodedBytes: number(result["decodedBytes"], 0),
      } };
    }
  }
}
