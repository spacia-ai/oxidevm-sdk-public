import { exactKeys, record } from "../runtime/decode.js";
import { decodeSHA256 } from "../values.js";
import { isCapability } from "./capabilities.js";
import type { Capability } from "./capabilities.js";
import { canonicalBytes, choice, decoding, GITHUB_REPOSITORY, integerIn, invalid, list, parseJSON, plainStrings, relativePath, sameBytes, text, unique } from "./decode-support.js";
import { ARTIFACT_NAME, MAX_ARTIFACT_BYTES, RESERVED_RELEASE_FILES } from "./manifest-parts.js";

export const MAX_LOCK_BYTES = 1024 * 1024;
const MODULE_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** A signal GitHub may not expose for every repository or plan: recorded, never assumed. */
export type Tristate = "yes" | "no" | "unknown";

export type LockedSource =
  | { readonly kind: "github"; readonly repository: string; readonly tag: string; readonly commit: string; readonly immutable: Tristate; readonly attested: Tristate }
  | { readonly kind: "file"; readonly path: string };

export interface LockedPin {
  readonly sha256: string;
  readonly bytes: number;
}

export interface LockedModule {
  readonly source: LockedSource;
  readonly version: string;
  /** sha256 of the exact `module.json` bytes. */
  readonly manifestSha256: string;
  readonly adapter: LockedPin;
  readonly artifacts: readonly (LockedPin & { readonly name: string })[];
  /** The capabilities the user consented to; a later release asking for more needs consent again. */
  readonly capabilities: readonly Capability[];
  /** Digest of the sorted `SHA256SUMS` lines. */
  readonly release: string;
}

/** `oxidevm.modules.lock.json`: no timestamps, so identical resolutions give identical bytes. */
export interface ModulesLock {
  readonly schemaVersion: 1;
  readonly modules: Readonly<Record<string, LockedModule>>;
}

function decodePin(value: unknown, label: string): LockedPin {
  const item = record(value, label);
  exactKeys(item, ["sha256", "bytes"]);
  return { sha256: decodeSHA256(item["sha256"], `${label} sha256`), bytes: integerIn(item["bytes"], `${label} bytes`, 0, MAX_ARTIFACT_BYTES) };
}

function decodeSource(value: unknown): LockedSource {
  const item = record(value, "source");
  const kind = choice(item["kind"], "source kind", ["github", "file"]);
  if (kind === "file") {
    exactKeys(item, ["kind", "path"]);
    return { kind, path: relativePath(item["path"], "source path") };
  }
  exactKeys(item, ["kind", "repository", "tag", "commit", "immutable", "attested"]);
  return {
    kind,
    repository: text(item["repository"], "source repository", GITHUB_REPOSITORY, 140),
    tag: text(item["tag"], "source tag", TAG, 128),
    commit: text(item["commit"], "source commit", COMMIT, 40),
    immutable: choice(item["immutable"], "source immutable", ["yes", "no", "unknown"]),
    attested: choice(item["attested"], "source attested", ["yes", "no", "unknown"]),
  };
}

function decodeLocked(value: unknown, id: string): LockedModule {
  const label = `modules.${id}`;
  const item = record(value, label);
  exactKeys(item, ["source", "version", "manifestSha256", "adapter", "artifacts", "capabilities", "release"]);
  const artifacts = list(item["artifacts"], `${label}.artifacts`, 64).map((entry): LockedPin & { readonly name: string } => {
    const artifact = record(entry, `${label}.artifacts[]`);
    exactKeys(artifact, ["name", "sha256", "bytes"]);
    const name = text(artifact["name"], "artifact name", ARTIFACT_NAME, 128);
    if (RESERVED_RELEASE_FILES.includes(name)) invalid("artifact name", `${name} is reserved for the release itself`);
    return { name, ...decodePin({ sha256: artifact["sha256"], bytes: artifact["bytes"] }, "artifact") };
  });
  unique(artifacts.map(artifact => artifact.name), `${label}.artifacts`);
  const capabilities = list(item["capabilities"], `${label}.capabilities`, 16).map((entry): Capability => {
    if (!isCapability(entry)) return invalid(`${label}.capabilities`, `${JSON.stringify(entry)} is not a known capability`);
    return entry;
  });
  unique(capabilities, `${label}.capabilities`);
  return {
    source: decodeSource(item["source"]),
    version: text(item["version"], "version", SEMVER, 128),
    manifestSha256: decodeSHA256(item["manifestSha256"], "manifestSha256"),
    adapter: decodePin(item["adapter"], "adapter"),
    artifacts,
    capabilities: [...capabilities].sort(),
    release: decodeSHA256(item["release"], "release"),
  };
}

/** The entry for `id`, never something a plain object inherits (`constructor` is a legal module id). */
export function lockedEntry(lock: ModulesLock, id: string): LockedModule | undefined {
  return Object.hasOwn(lock.modules, id) ? lock.modules[id] : undefined;
}

export function decodeModulesLock(value: unknown): ModulesLock {
  return decoding("oxidevm.modules.lock.json", () => {
    const input = record(value, "oxidevm.modules.lock.json");
    exactKeys(input, ["schemaVersion", "modules"]);
    if (input["schemaVersion"] !== 1) invalid("oxidevm.modules.lock.json", "schemaVersion must be 1");
    const modules = record(input["modules"], "modules");
    const ids = Object.keys(modules).sort();
    if (ids.length > 64) invalid("modules", "locks more than 64 modules");
    const output: Record<string, LockedModule> = {};
    for (const id of ids) {
      if (!MODULE_ID.test(id)) invalid("modules", `module id ${JSON.stringify(id)} is invalid`);
      output[id] = decodeLocked(modules[id], id);
    }
    plainStrings(output, "oxidevm.modules.lock.json");
    return { schemaVersion: 1, modules: output };
  });
}

export function decodeModulesLockBytes(bytes: Uint8Array): ModulesLock {
  return decoding("oxidevm.modules.lock.json", () => {
    const lock = decodeModulesLock(parseJSON(bytes, "oxidevm.modules.lock.json", MAX_LOCK_BYTES));
    if (!sameBytes(bytes, canonicalBytes(lock))) invalid("oxidevm.modules.lock.json", "is not in canonical form (sorted modules, two-space JSON, one newline)");
    return lock;
  });
}

export function encodeModulesLock(lock: ModulesLock): Uint8Array<ArrayBuffer> {
  return canonicalBytes(decodeModulesLock(lock));
}
