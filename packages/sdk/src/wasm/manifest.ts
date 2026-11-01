import { exactKeys, record } from "../runtime/decode.js";
import { canonicalBytes, choice, decoding, invalid, parseJSON, plainStrings, sameBytes, text } from "./decode-support.js";
import {
  decodeCommands, decodeDeclaredArtifacts, decodeExpose, decodeGuestFiles, decodeLicense, decodeLimits, decodeMounts, decodeOptions, decodePin,
  decodeProcess, decodeRequires, decodeResolvedArtifacts, decodeState, decodeUpstream, rejectOwnCommands,
} from "./manifest-parts.js";
import type { AbiKind, ArtifactDecl, CommonDecl, EndpointDecl, ModuleDecl, ResolvedArtifact, ResolvedManifest, ServiceDecl } from "./manifest-types.js";

export const MAX_MANIFEST_BYTES = 256 * 1024;
const ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ABIS = ["wasi", "component", "emscripten", "bindgen", "raw"] as const satisfies readonly AbiKind[];
const OPTIONAL = ["commands", "expose", "mounts", "limits", "state", "guestFiles", "options", "upstream"] as const;

/** The discriminant is nested (`process.kind`), so TypeScript cannot narrow a ModuleDecl by it; this guard can. */
export function isServiceDecl(manifest: ModuleDecl): manifest is ServiceDecl {
  return manifest.process.kind === "service";
}

type Body = Omit<CommonDecl, "artifacts" | "id" | "version" | "abi">;
interface Decoded {
  readonly head: { readonly id: string; readonly version: string; readonly abi: AbiKind };
  readonly process: ReturnType<typeof decodeProcess>;
  /** Present only for a command that declares them. */
  readonly commands: readonly string[] | undefined;
  readonly expose: Readonly<Record<string, EndpointDecl>> | undefined;
  readonly tail: Body;
}

function decodeBody(input: Readonly<Record<string, unknown>>, artifactNames: ReadonlySet<string>): Decoded {
  const process = decodeProcess(input["process"]);
  if (process.kind === "service" && input["commands"] !== undefined) invalid("commands", "a service cannot declare commands; only a command module runs as a program");
  const commands = input["commands"] === undefined ? undefined : decodeCommands(input["commands"]);
  const expose = input["expose"] === undefined ? undefined : decodeExpose(input["expose"]);
  if (process.kind === "service" && expose === undefined) invalid("module", "a service must declare expose");
  if (process.kind === "command" && expose !== undefined) invalid("module", "a command cannot declare expose");
  const limits = input["limits"] === undefined ? undefined : decodeLimits(input["limits"]);
  if (process.kind === "command" && limits?.clients !== undefined) invalid("limits", "clients applies only to services");
  const mounts = input["mounts"] === undefined ? undefined : decodeMounts(input["mounts"]);
  const state = input["state"] === undefined ? undefined : decodeState(input["state"]);
  for (const path of state?.durable ?? []) {
    const covered = mounts?.some(mount => mount.access === "rw" && (path === mount.guest || path.startsWith(`${mount.guest}/`))) === true;
    if (!covered) invalid("state.durable", `${path} is not inside a read-write mount`);
  }
  const guestFiles = input["guestFiles"] === undefined ? undefined : decodeGuestFiles(input["guestFiles"], artifactNames);
  const options = input["options"] === undefined ? undefined : decodeOptions(input["options"]);
  const upstream = input["upstream"] === undefined ? undefined : decodeUpstream(input["upstream"]);
  const decoded: Decoded = {
    head: { id: text(input["id"], "id", ID, 63), version: text(input["version"], "version", SEMVER, 128), abi: choice(input["abi"], "abi", ABIS) },
    process,
    commands,
    expose,
    tail: {
      requires: decodeRequires(input["requires"]),
      ...(mounts === undefined ? {} : { mounts }),
      ...(limits === undefined ? {} : { limits }),
      ...(state === undefined ? {} : { state }),
      ...(guestFiles === undefined ? {} : { guestFiles }),
      ...(options === undefined ? {} : { options }),
      license: decodeLicense(input["license"], artifactNames),
      ...(upstream === undefined ? {} : { upstream }),
    },
  };
  if (commands !== undefined) rejectOwnCommands(commands, decoded.tail.requires.guest?.executables ?? []);
  return decoded;
}

/** Keys in canonical order: id, version, abi, artifacts, process, a command's commands or a service's expose, then the shared tail. */
function shapeDeclared(decoded: Decoded, artifacts: readonly ArtifactDecl[]): ModuleDecl {
  const { head, process, commands, expose, tail } = decoded;
  if (process.kind === "service" && expose !== undefined) return { ...head, artifacts, process, expose, ...tail };
  return { ...head, artifacts, process: { kind: "command" }, ...(commands === undefined ? {} : { commands }), ...tail };
}

/** Canonical order for `module.json`: schemaVersion first, the adapter pin before the artifacts. */
function shapeResolved(decoded: Decoded, pin: { readonly sha256: string; readonly bytes: number }, artifacts: readonly ResolvedArtifact[]): ResolvedManifest {
  const { head, process, commands, expose, tail } = decoded;
  const adapter = { api: 1 as const, sha256: pin.sha256, bytes: pin.bytes };
  if (process.kind === "service" && expose !== undefined) return { schemaVersion: 1, ...head, adapter, artifacts, process, expose, ...tail };
  return { schemaVersion: 1, ...head, adapter, artifacts, process: { kind: "command" }, ...(commands === undefined ? {} : { commands }), ...tail };
}

/** An author's manifest literal: artifacts name repository files, and nothing is hashed yet. */
export function decodeDeclaration(value: unknown): ModuleDecl {
  return decoding("module declaration", () => {
    const input = record(value, "module declaration");
    exactKeys(input, ["id", "version", "abi", "artifacts", "process", "requires", "license"], OPTIONAL);
    const artifacts = decodeDeclaredArtifacts(input["artifacts"]);
    return shapeDeclared(decodeBody(input, new Set(artifacts.map(artifact => artifact.name))), artifacts);
  });
}

/** The decoded contents of a release's `module.json`. */
export function decodeResolvedManifest(value: unknown): ResolvedManifest {
  return decoding("module.json", () => {
    const input = record(value, "module.json");
    exactKeys(input, ["schemaVersion", "id", "version", "abi", "adapter", "artifacts", "process", "requires", "license"], OPTIONAL);
    if (input["schemaVersion"] !== 1) invalid("module.json", "schemaVersion must be 1");
    const adapter = record(input["adapter"], "adapter");
    exactKeys(adapter, ["api", "sha256", "bytes"]);
    if (adapter["api"] !== 1) invalid("adapter", "api must be 1");
    const pin = decodePin({ sha256: adapter["sha256"], bytes: adapter["bytes"] }, "adapter");
    const artifacts = decodeResolvedArtifacts(input["artifacts"]);
    const manifest = shapeResolved(decodeBody(input, new Set(artifacts.map(artifact => artifact.name))), pin, artifacts);
    plainStrings(manifest, "module.json");
    return manifest;
  });
}

export function decodeModuleManifest(bytes: Uint8Array): ResolvedManifest {
  return decoding("module.json", () => {
    const manifest = decodeResolvedManifest(parseJSON(bytes, "module.json", MAX_MANIFEST_BYTES));
    if (!sameBytes(bytes, canonicalBytes(manifest))) invalid("module.json", "is not in canonical form (two-space JSON in schema order, then one newline)");
    return manifest;
  });
}

export function encodeModuleManifest(manifest: ResolvedManifest): Uint8Array<ArrayBuffer> {
  return canonicalBytes(decodeResolvedManifest(manifest));
}
