import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import type { FileArtifactInput } from "./contracts.js";
import { verifyArtifact } from "./files.js";

type QualifiedAddon = { readonly name: "next"; readonly version: "16.2.12" } | { readonly name: "swc"; readonly version: "1.15.47" | "1.16.13" }
  | { readonly name: "rollup"; readonly version: "4.64.2" }
  | { readonly name: "oxidevm-node-api-conformance"; readonly version: "1" };
interface NativeAddonArtifact {
  readonly path: string;
  readonly artifact: FileArtifactInput;
}
type NativeCapabilityRequirements = readonly ["promise-is-promise-v1"] | readonly ["error-is-error-v1"]
  | readonly ["promise-is-promise-v1", "error-is-error-v1"];
export type AccelerationProfileOptions = {
  readonly dependencies: string;
  readonly host: FileArtifactInput;
  /** Complete immutable guest-image packages. Rust verifies their source and content at launch. */
  readonly codeRoots?: readonly string[];
} & ({ readonly profile: "node24-bun1-v1"; readonly addons: readonly (QualifiedAddon & NativeAddonArtifact)[] }
  | {
    /** Requires an engine built with native-parity-fixtures; this is not a compatibility claim. */
    readonly profile: "native-parity-fixture-v1";
    readonly platform: { readonly os: "linux"; readonly architecture: "x86_64"; readonly libc: "musl"; readonly cpu: "x86-64-v3" };
    readonly capability: "node-api-experimental-v1";
    readonly addons: readonly NativeAddonArtifact[];
    /** Managed or captured dependency libraries; Rust validates names, canonical paths and bytes. */
    readonly libraries?: readonly (NativeAddonArtifact & { readonly name: string })[];
    readonly requiredCapabilities?: NativeCapabilityRequirements;
    /** Bind runtime-specific native semantics before execution; legacy profiles retain their prior contract. */
    readonly requiredRuntime?: "node" | "bun";
  });

function artifact(value: unknown): FileArtifactInput {
  const input = record(value, "acceleration artifact"); exactKeys(input, ["path", "sha256"]);
  const path = string(input["path"], "artifact.path");
  if (path === "" || path.length > 8192 || path.includes("\0")) throw new VMError("INVALID_ARGUMENT", "Invalid acceleration artifact path");
  return { path, sha256: decodeSHA256(input["sha256"], "artifact.sha256") };
}
function guestPath(value: unknown, workspace = true): string {
  const path = string(value, "acceleration guest path"), encoder = new TextEncoder();
  if (!path.startsWith(workspace ? "/workspace/" : "/") || encoder.encode(path).length >= 4096 || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || path.slice(1).split("/").some(part => part === "" || part === "." || part === ".." || encoder.encode(part).length > 255)) throw new VMError("INVALID_ARGUMENT", "Invalid acceleration guest path");
  return path;
}

function capabilityRequirements(value: unknown): NativeCapabilityRequirements | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === "promise-is-promise-v1") return ["promise-is-promise-v1"];
    if (value.length === 1 && value[0] === "error-is-error-v1") return ["error-is-error-v1"];
    if (value.length === 2 && value[0] === "promise-is-promise-v1" && value[1] === "error-is-error-v1") return ["promise-is-promise-v1", "error-is-error-v1"];
  }
  throw new VMError("INVALID_ARGUMENT", "Invalid native capability requirements");
}

function runtimeRequirement(value: unknown): "node" | "bun" | undefined {
  if (value === undefined || value === "node" || value === "bun") return value;
  throw new VMError("INVALID_ARGUMENT", "Invalid native runtime requirement");
}

/** Generate image metadata. Rust authenticates bytes and captured generations independently at launch. */
export async function createAccelerationProfile(options: AccelerationProfileOptions): Promise<{ readonly path: "/usr/local/share/oxidevm/acceleration.profile"; readonly bytes: Uint8Array }> {
  const input = record(options, "acceleration profile"), fixture = input["profile"] === "native-parity-fixture-v1";
  exactKeys(input, ["profile", "dependencies", "host", "addons", ...(fixture ? ["platform", "capability"] : [])], ["codeRoots", ...(fixture ? ["libraries", "requiredCapabilities", "requiredRuntime"] : [])]);
  const declaredRoots = input["codeRoots"] === undefined ? [] : input["codeRoots"];
  if (!Array.isArray(declaredRoots) || declaredRoots.length > 64) throw new VMError("INVALID_ARGUMENT", "Invalid image code roots");
  const codeRoots = Array.from(declaredRoots, (value: unknown) => guestPath(value, false));
  if (fixture && codeRoots.length > 0 || codeRoots.some((path, index) => path === "/workspace" || path.startsWith("/workspace/") || path === input["dependencies"] || codeRoots.some((other, otherIndex) => index !== otherIndex && (path === other || path.startsWith(other + "/"))))) throw new VMError("INVALID_ARGUMENT", "Overlapping or unsupported image code roots");
  const required = capabilityRequirements(input["requiredCapabilities"]);
  const requiredRuntime = runtimeRequirement(input["requiredRuntime"]);
  if (!fixture && input["profile"] !== "node24-bun1-v1") throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported acceleration profile");
  if (fixture) {
    const platform = record(input["platform"], "native artifact platform"); exactKeys(platform, ["os", "architecture", "libc", "cpu"]);
    if (platform["os"] !== "linux" || platform["architecture"] !== "x86_64" || platform["libc"] !== "musl" || platform["cpu"] !== "x86-64-v3" || input["capability"] !== "node-api-experimental-v1") throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported native qualification capability");
  }
  const dependencies = guestPath(input["dependencies"]), host = artifact(input["host"]);
  if (!dependencies.endsWith("/node_modules")) throw new VMError("INVALID_ARGUMENT", "Acceleration dependency path must end in node_modules");
  const requested = input["addons"];
  if (!Array.isArray(requested) || requested.length > 8) throw new VMError("INVALID_ARGUMENT", "Acceleration supports at most eight native addons");
  const paths = new Set<string>();
  const addons = requested.map((value: unknown) => {
    const addon = record(value, "acceleration addon"); exactKeys(addon, fixture ? ["path", "artifact"] : ["name", "version", "path", "artifact"]);
    const path = guestPath(addon["path"]), file = artifact(addon["artifact"]);
    let declaration = `artifact\tnode-api\t${file.sha256}\t${path}`;
    if (!fixture) {
      const name = addon["name"], version = addon["version"];
      if (!((name === "next" && version === "16.2.12") || (name === "swc" && (version === "1.15.47" || version === "1.16.13")) || (name === "rollup" && version === "4.64.2") || (name === "oxidevm-node-api-conformance" && version === "1"))) throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported native addon version");
      declaration = `addon\t${name}\t${version}\t${path}`;
    }
    if (!path.startsWith(dependencies + "/") || !path.endsWith(".node")) throw new VMError("INVALID_ARGUMENT", "Native addon path must be inside its dependency generation");
    if (paths.has(path)) throw new VMError("INVALID_ARGUMENT", "Native addon path is duplicate"); paths.add(path);
    return { path, artifact: file, declaration };
  });
  const declared = input["libraries"] === undefined ? [] : input["libraries"], names = new Set<string>();
  if (!Array.isArray(declared) || declared.length > 32) throw new VMError("INVALID_ARGUMENT", "Acceleration supports at most 32 shared libraries");
  const libraries = declared.map((value: unknown) => {
    const library = record(value, "native shared library"); exactKeys(library, ["name", "path", "artifact"]);
    const name = string(library["name"], "library.name"), path = guestPath(library["path"], false), file = artifact(library["artifact"]);
    if (name === "" || name === "." || name === ".." || name.includes("/") || new TextEncoder().encode(name).length > 255 || Array.from(name).some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)) throw new VMError("INVALID_ARGUMENT", "Invalid shared-library name");
    if (!["/lib/", "/usr/lib/", "/usr/local/lib/"].some(directory => path === directory + name) && !(name === "libc.musl-x86_64.so.1" && path === "/lib/ld-musl-x86_64.so.1")
      && !(path.startsWith(dependencies + "/") && path.endsWith("/" + name))) throw new VMError("FEATURE_NOT_AVAILABLE", "Shared library must use a managed path or its captured dependency root");
    if (paths.has(path) || names.has(name)) throw new VMError("INVALID_ARGUMENT", "Duplicate shared-library identity"); paths.add(path); names.add(name);
    return { artifact: file, vendored: path.startsWith(dependencies + "/"), declaration: `library\t${name}\t${file.sha256}\t${path}` };
  });
  for (const file of [host, ...addons.map(addon => addon.artifact), ...libraries.map(library => library.artifact)]) await verifyArtifact(file, process.cwd());
  const version = requiredRuntime !== undefined ? 7 : required === undefined ? libraries.some(library => library.vendored) ? 4 : input["libraries"] === undefined ? 2 : 3 : required.length === 1 && required[0] === "promise-is-promise-v1" ? 5 : 6;
  const header = fixture ? [`OXAP\t${String(version)}`, "profile\tnative-parity-fixture-v1", "platform\tlinux-x86_64\tmusl\tx86-64-v3", "capability\tnode-api-experimental-v1", ...(requiredRuntime === undefined ? [] : [`requires-runtime\t${requiredRuntime}`]), ...(required === undefined ? [] : [`requires\t${required.join("\t")}`])] : ["OXAP\t1", "profile\tnode24-bun1-v1"];
  if (codeRoots.length > 0) header[0] = "OXAP\t8";
  const lines = [...header, `host\t${host.sha256}\t/usr/local/libexec/oxidevm-node-api-host`, `dependencies\t${dependencies}`, ...codeRoots.map(path => `code-root\t${path}`), ...addons.map(addon => addon.declaration), ...libraries.map(library => library.declaration)];
  const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
  if (bytes.length > 65536) throw new VMError("QUOTA_EXCEEDED", "Acceleration profile exceeds its byte bound");
  return { path: "/usr/local/share/oxidevm/acceleration.profile", bytes };
}
