import { decodeImageSmokeTest as smoke } from "../image-smoke.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VMError } from "../runtime/errors.js";
import { exactKeys, integer, record, string } from "../runtime/decode.js";
import { decodeSHA256 } from "../values.js";
import type { BootFilesSource, CommonImageRecipe, SystemImageRecipe, EvidenceInputs, FileArtifactInput, ImageRecipe, UserspaceImageRecipe, KernelSource, RootfsSource } from "./contracts.js";

function text(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length === 0 || result.length > 8192 || result.includes("\0")) throw new VMError("INVALID_ARGUMENT", `${label} must be nonempty text without NUL`);
  return result;
}

function artifact(value: unknown): FileArtifactInput {
  const input = record(value, "file artifact");
  exactKeys(input, ["path", "sha256"]);
  return { path: text(input["path"], "artifact.path"), sha256: decodeSHA256(input["sha256"], "artifact.sha256") };
}

function strings(value: unknown, label: string): Readonly<Record<string, string>> {
  const input = record(value, label);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new VMError("INVALID_ARGUMENT", `${label} has an invalid key`);
    output[key] = string(value, `${label}.${key}`);
  }
  return output;
}

function source(value: unknown): RootfsSource | BootFilesSource {
  const input = record(value, "image source");
  const kind = input["kind"];
  switch (kind) {
    case "directory":
      exactKeys(input, ["kind", "path"]);
      return { kind, path: text(input["path"], "source.path") };
    case "archive":
      exactKeys(input, ["kind", "artifact"]);
      return { kind, artifact: artifact(input["artifact"]) };
    case "oci":
      exactKeys(input, ["kind", "reference"]);
      return { kind, reference: text(input["reference"], "source.reference") };
    case "dockerfile":
      exactKeys(input, ["kind", "context", "file"], ["target", "buildArgs"]);
      return { kind, context: text(input["context"], "source.context"), file: text(input["file"], "source.file"),
        ...(input["target"] === undefined ? {} : { target: text(input["target"], "source.target") }),
        ...(input["buildArgs"] === undefined ? {} : { buildArgs: strings(input["buildArgs"], "source.buildArgs") }) };
    case "boot-files":
      exactKeys(input, ["kind", "kernel", "disk", "commandLine"], ["initrd"]);
      return { kind, kernel: artifact(input["kernel"]), disk: artifact(input["disk"]), commandLine: text(input["commandLine"], "source.commandLine"),
        ...(input["initrd"] === undefined ? {} : { initrd: artifact(input["initrd"]) }) };
    default: throw new VMError("INVALID_ARGUMENT", "unsupported image source");
  }
}

function kernel(value: unknown): KernelSource {
  const input = record(value, "kernel");
  if (input["kind"] === "managed-default") { exactKeys(input, ["kind"]); return { kind: "managed-default" }; }
  if (input["kind"] === "file") { exactKeys(input, ["kind", "artifact"]); return { kind: "file", artifact: artifact(input["artifact"]) }; }
  throw new VMError("INVALID_ARGUMENT", "unsupported kernel source");
}


function evidence(value: unknown): EvidenceInputs {
  const input = record(value, "evidence");
  exactKeys(input, ["sbom", "noticesFile", "correspondingSourcesFile", "licensePolicyFile"]);
  const sbom = record(input["sbom"], "evidence.sbom");
  let decoded: EvidenceInputs["sbom"];
  if (sbom["kind"] === "buildkit") { exactKeys(sbom, ["kind"]); decoded = { kind: "buildkit" }; }
  else if (sbom["kind"] === "file") { exactKeys(sbom, ["kind", "path"]); decoded = { kind: "file", path: text(sbom["path"], "sbom.path") }; }
  else throw new VMError("INVALID_ARGUMENT", "unsupported SBOM input");
  return { sbom: decoded, noticesFile: text(input["noticesFile"], "noticesFile"), correspondingSourcesFile: text(input["correspondingSourcesFile"], "correspondingSourcesFile"), licensePolicyFile: text(input["licensePolicyFile"], "licensePolicyFile") };
}

/** An author's workspace owner is an argument, so every malformed value is an invalid one. The
 * largest ID is 4294967294: Linux reserves 4294967295 as "unchanged", and the runtime refuses it. */
function workspace(value: unknown): NonNullable<UserspaceImageRecipe["workspace"]> {
  try {
    const input = record(value, "workspace"); exactKeys(input, ["ownership"]);
    const ownership = record(input["ownership"], "workspace.ownership"); exactKeys(ownership, ["uid", "gid"]);
    return { ownership: { uid: integer(ownership["uid"], "workspace.ownership.uid", 0, 0xffff_fffe), gid: integer(ownership["gid"], "workspace.ownership.gid", 0, 0xffff_fffe) } };
  } catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}

export function decodeImageRecipe(value: unknown): ImageRecipe {
  const input = record(value, "image recipe");
  exactKeys(input, ["id", "version", "mode", "source", "smokeTest"], ["cpuProfile", "sourceDateEpoch", "evidence", "resources", "boot", "disk", "workspace"]);
  const id = text(input["id"], "id"); const version = text(input["version"], "version");
  if (![id, version].every(value => /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value))) throw new VMError("INVALID_ARGUMENT", "image ID/version must be bounded portable identifiers");
  const cpuProfile = input["cpuProfile"];
  if (cpuProfile !== undefined && cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") throw new VMError("INVALID_ARGUMENT", "invalid CPU profile");
  const common: CommonImageRecipe = { id, version, smokeTest: smoke(input["smokeTest"]),
    ...(cpuProfile === undefined ? {} : { cpuProfile }),
    ...(input["sourceDateEpoch"] === undefined ? {} : { sourceDateEpoch: integer(input["sourceDateEpoch"], "sourceDateEpoch", 0) }),
    ...(input["evidence"] === undefined ? {} : { evidence: evidence(input["evidence"]) }) };
  const decodedSource = source(input["source"]);
  const resources = input["resources"] === undefined ? undefined : record(input["resources"], "resources");
  const memory = resources?.["memoryMiB"];
  const memoryMiB = memory === undefined ? {} : { memoryMiB: integer(memory, "memoryMiB", 256, 3072) };
  if (input["mode"] === "userspace") {
    if (input["boot"] !== undefined || input["disk"] !== undefined || decodedSource.kind === "boot-files") throw new VMError("INVALID_ARGUMENT", "Userspace recipes cannot contain boot files or a disk");
    if (resources !== undefined) exactKeys(resources, [], ["memoryMiB", "maxProcesses"]);
    return { ...common, mode: "userspace", source: decodedSource,
      ...(resources === undefined ? {} : { resources: { ...memoryMiB, ...(resources["maxProcesses"] === undefined ? {} : { maxProcesses: integer(resources["maxProcesses"], "maxProcesses", 1, 64) }) } }),
      ...(input["workspace"] === undefined ? {} : { workspace: workspace(input["workspace"]) }) };
  }
  if (input["mode"] !== "system") throw new VMError("INVALID_ARGUMENT", "mode must be system or userspace");
  if (input["workspace"] !== undefined) throw new VMError("INVALID_ARGUMENT", "workspace ownership is a Userspace recipe option; a System disk keeps the owners its source recorded");
  if (resources !== undefined) exactKeys(resources, [], ["memoryMiB", "vcpus"]);
  const vcpus = resources?.["vcpus"];
  if (vcpus !== undefined && vcpus !== 1 && vcpus !== 2 && vcpus !== 3 && vcpus !== 4) throw new VMError("INVALID_ARGUMENT", "invalid vCPU count");
  const system: CommonImageRecipe & Pick<SystemImageRecipe, "mode" | "resources"> = { ...common, mode: "system", ...(resources === undefined ? {} : { resources: { ...memoryMiB, ...(vcpus === undefined ? {} : { vcpus }) } }) };
  if (decodedSource.kind === "boot-files") {
    if (input["boot"] !== undefined || input["disk"] !== undefined) throw new VMError("INVALID_ARGUMENT", "boot-files cannot also configure boot or disk");
    return { ...system, source: decodedSource };
  }
  const boot = record(input["boot"], "boot"); exactKeys(boot, ["kernel"], ["initrd", "commandLine"]);
  const disk = input["disk"] === undefined ? undefined : record(input["disk"], "disk");
  if (disk !== undefined) exactKeys(disk, [], ["sizeMiB"]);
  return { ...system, source: decodedSource, boot: { kernel: kernel(boot["kernel"]), ...(boot["initrd"] === undefined ? {} : { initrd: artifact(boot["initrd"]) }),
    ...(boot["commandLine"] === undefined ? {} : { commandLine: text(boot["commandLine"], "commandLine") }) },
    ...(disk === undefined ? {} : { disk: disk["sizeMiB"] === undefined ? {} : { sizeMiB: integer(disk["sizeMiB"], "sizeMiB", 32, 8192) } }) };
}

export async function loadImageRecipe(path: string): Promise<ImageRecipe> {
  const absolute = resolve(path);
  const value: unknown = absolute.endsWith(".json") ? JSON.parse(await readFile(absolute, "utf8")) as unknown : await import(pathToFileURL(absolute).href) as unknown;
  return decodeImageRecipe(absolute.endsWith(".json") ? value : record(value, "recipe module")["default"]);
}
