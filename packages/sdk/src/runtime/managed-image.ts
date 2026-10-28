import { decodeManagedRuntimes, type ManagedRuntimes } from "./managed-runtimes.js";
import { isTrustworthyURL } from "../trustworthy-url.js";
import { canonicalImageBytes, decodeImageProvenance, rememberArtifactURL, verifyImageProvenance, type ImageProvenance, type ImageTrust } from "./image-provenance.js";
import {
  exactKeys,
  integer,
  protocolError,
  record,
  string,
} from "./decode.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const CATALOG_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_COMMAND_LINE_BYTES = 4096;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** A profile lists a few shipped restore points (examples, templates), never many. */
const MAX_SHIPPED_SNAPSHOTS = 16;

export interface ManagedImageArtifact {
  readonly url: URL;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedImageChunk extends ManagedImageArtifact {
  readonly index: number;
  readonly encoding: "gzip";
  readonly encodedBytes: number;
  readonly encodedSha256: string;
}

/**
 * A restore point shipped with a profile (schema 8, ADR 0014): its signed manifest at
 * `./snapshots/<name>/manifest.json` beside the profile, and the bytes its download stores.
 */
export interface ManagedImageSnapshot {
  readonly name: string;
  readonly manifest: ManagedImageArtifact;
  readonly bytes: number;
}

export interface ManagedImageManifest {
  /** Decode context only; relocation never changes signed relative artifact identities. */
  readonly manifestUrl?: URL;
  readonly schemaVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  readonly id: string;
  readonly version: string;
  readonly architecture: "x86_64";
  readonly sourceDateEpoch: number;
  readonly memoryMiB: number;
  readonly vcpus: 1 | 2 | 3 | 4;
  /** The signed upper bound in whole-image manifests; legacy profiles retain their identity. */
  readonly maximumVcpus?: 1 | 2 | 3 | 4;
  readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
  readonly provenance?: ImageProvenance;
  readonly workspaceBaseSha256?: string;
  readonly aot?: ManagedImageArtifact;
  readonly commandLine: string;
  readonly kernel: ManagedImageArtifact;
  readonly initrd?: ManagedImageArtifact;
  readonly disk: {
    readonly bytes: number;
    readonly blockBytes: 4096;
    readonly chunkBytes: number;
    readonly chunks: readonly ManagedImageChunk[];
  };
  readonly runtimes: ManagedRuntimes;
  /** Shipped restore points (schema 8); they are not part of the image's identity. */
  readonly snapshots?: readonly ManagedImageSnapshot[];
}

export function managedImageUrl(
  value: string | URL,
  base?: string | URL,
): URL {
  const url =
    value instanceof URL
      ? new URL(value.href)
      : base === undefined
        ? new URL(value)
        : new URL(value, base);
  if (
    !isSecureUrl(url) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw protocolError("managed image URL must be a trustworthy HTTP URL");
  }
  return url;
}

export function decodeManagedImageManifest(
  value: unknown,
  manifestUrl: URL,
): ManagedImageManifest {
  const source = record(value, "managed image manifest");
  exactKeys(
    source,
    [
      "schemaVersion",
      "id",
      "version",
      "architecture",
      "sourceDateEpoch",
      "memoryMiB",
      "vcpus",
      "cpuProfile",
      "commandLine",
      "kernel",
      "disk",
      "runtimes",
      ...(source["schemaVersion"] === 5 || source["schemaVersion"] === 6 || source["schemaVersion"] === 7
        || source["schemaVersion"] === 8 || source["schemaVersion"] === 9
        ? ["workspaceBaseSha256"]
        : []),
      ...(source["schemaVersion"] === 9 ? ["provenance"] : []),
    ],
    [
      "initrd",
      ...((source["schemaVersion"] === 6 || source["schemaVersion"] === 7 || source["schemaVersion"] === 8 || source["schemaVersion"] === 9) ? ["aot"] : []),
      ...(source["schemaVersion"] === 8 || source["schemaVersion"] === 9 ? ["snapshots"] : []),
    ],
  );
  const schemaVersion = integer(source["schemaVersion"], "schemaVersion");
  if (
    schemaVersion !== 2
    && schemaVersion !== 3
    && schemaVersion !== 4
    && schemaVersion !== 5
    && schemaVersion !== 6
    && schemaVersion !== 7
    && schemaVersion !== 8
    && schemaVersion !== 9
  ) {
    throw protocolError("unsupported managed image schema");
  }
  if (string(source["architecture"], "architecture") !== "x86_64") {
    throw protocolError("managed image architecture must be x86_64");
  }
  const vcpus = schemaVersion >= 4
    ? decodeVcpuRangeMinimum(source["vcpus"])
    : decodeVcpus(source["vcpus"]);
  if (schemaVersion === 2 && vcpus !== 1) {
    throw protocolError("managed image schema 2 must use one vCPU");
  }
  const cpuProfile = string(source["cpuProfile"], "cpuProfile");
  if (cpuProfile !== "x86-64-v3" && !(schemaVersion === 9 && cpuProfile === "x86-64-v2")) {
    throw protocolError("managed image must use x86-64-v3");
  }

  const commandLine = nonempty(source["commandLine"], "commandLine");
  if (
    commandLine.includes("\0") ||
    new TextEncoder().encode(commandLine).byteLength > MAX_COMMAND_LINE_BYTES
  ) {
    throw protocolError("managed image command line is invalid");
  }
  const disk = decodeDisk(source["disk"], manifestUrl);
  const runtimes = decodeManagedRuntimes(source["runtimes"]);
  if (schemaVersion < 9 && "kind" in runtimes) throw protocolError("custom runtimes require schema nine");
  if (schemaVersion < 7 && !("alpine" in runtimes)) throw protocolError("Debian runtimes require schema seven");

  return {
    schemaVersion,
    ...(schemaVersion === 9 ? { manifestUrl: new URL(manifestUrl.href) } : {}),
    id: catalogId(source["id"], "id"),
    version: catalogId(source["version"], "version"),
    architecture: "x86_64",
    sourceDateEpoch: integer(source["sourceDateEpoch"], "sourceDateEpoch", 0),
    memoryMiB: integer(source["memoryMiB"], "memoryMiB", 256, 3072),
    vcpus,
    ...(schemaVersion === 9 ? { maximumVcpus: decodeVcpus(record(source["vcpus"], "vcpus")["maximum"]) } : {}),
    cpuProfile,
    ...(schemaVersion === 9 ? { provenance: decodeImageProvenance(source["provenance"], manifestUrl) } : {}),
    ...(schemaVersion >= 5
      ? { workspaceBaseSha256: digest(source["workspaceBaseSha256"], "workspaceBaseSha256") }
      : {}),
    ...(schemaVersion >= 6 && source["aot"] !== undefined
      ? { aot: decodeArtifact(source["aot"], manifestUrl, "aot") }
      : {}),
    commandLine,
    kernel: decodeArtifact(source["kernel"], manifestUrl, "kernel"),
    ...(source["initrd"] === undefined
      ? {}
      : {
          initrd: decodeArtifact(source["initrd"], manifestUrl, "initrd"),
        }),
    disk,
    runtimes,
    ...(source["snapshots"] === undefined ? {} : { snapshots: decodeManagedImageSnapshots(source["snapshots"], manifestUrl) }),
  };
}

export function canonicalManagedImageBytes(manifest: ManagedImageManifest): Uint8Array<ArrayBuffer> {
  const { manifestUrl, ...signed } = manifest;
  return canonicalImageBytes({ ...signed, provenance: manifest.provenance === undefined ? undefined : { ...manifest.provenance, signature: "" } }, manifestUrl);
}

export function verifyManagedImageManifest(manifest: ManagedImageManifest, trust: ImageTrust): Promise<void> {
  return verifyImageProvenance(manifest.provenance, canonicalManagedImageBytes(manifest), trust);
}

/**
 * A schema-8 profile's shipped restore points: distinct names, each manifest exactly at
 * `./snapshots/<name>/manifest.json` beside the profile, so no entry can point elsewhere.
 */
export function decodeManagedImageSnapshots(value: unknown, manifestUrl: URL): ManagedImageSnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_SHIPPED_SNAPSHOTS) {
    throw protocolError("shipped restore points must be a short list");
  }
  const names = new Set<string>();
  return value.map((item: unknown, index) => {
    const label = `snapshots[${String(index)}]`;
    const entry = record(item, label);
    exactKeys(entry, ["name", "manifest", "bytes"]);
    const name = catalogId(entry["name"], `${label}.name`);
    const manifest = decodeArtifact(entry["manifest"], manifestUrl, `${label}.manifest`);
    if (names.has(name) || manifest.url.href !== new URL(`./snapshots/${name}/manifest.json`, manifestUrl).href) {
      throw protocolError(`${label} must be a distinct restore point in its own folder`);
    }
    names.add(name);
    return { name, manifest, bytes: integer(entry["bytes"], `${label}.bytes`, 1) };
  });
}

/**
 * The bytes whose SHA-256 identifies a managed image: its machine fields from schema 6 (so a new
 * AOT catalog, and from schema 8 a new shipped restore point, keeps the identity), and the exact
 * manifest text before that.
 */
export function managedImageIdentityBytes(
  value: unknown,
  text: string,
  manifest: ManagedImageManifest,
): Uint8Array<ArrayBuffer> {
  return manifest.schemaVersion >= 6
    ? managedImageMachineIdentityBytes(value)
    : new TextEncoder().encode(text);
}

export function managedImageMachineIdentityBytes(
  value: unknown,
): Uint8Array<ArrayBuffer> {
  const source = record(value, "managed image manifest");
  const machine = Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== "aot" && name !== "snapshots"),
  );
  return new TextEncoder().encode(JSON.stringify(canonical(machine)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, canonical(item)]),
  );
}

function decodeVcpuRangeMinimum(value: unknown): 1 | 2 | 3 | 4 {
  const range = record(value, "vcpus");
  exactKeys(range, ["minimum", "maximum"]);
  const minimum = decodeVcpus(range["minimum"]);
  const maximum = decodeVcpus(range["maximum"]);
  if (minimum > maximum) throw protocolError("managed image vCPU range is invalid");
  return minimum;
}

function decodeDisk(
  value: unknown,
  manifestUrl: URL,
): ManagedImageManifest["disk"] {
  const disk = record(value, "disk");
  exactKeys(disk, ["bytes", "blockBytes", "chunkBytes", "chunks"]);
  const bytes = integer(disk["bytes"], "disk.bytes", 4096);
  const blockBytes = integer(disk["blockBytes"], "disk.blockBytes");
  const chunkBytes = integer(
    disk["chunkBytes"],
    "disk.chunkBytes",
    4096,
    MAX_CHUNK_BYTES,
  );
  if (
    blockBytes !== 4096 ||
    !isPowerOfTwo(chunkBytes) ||
    chunkBytes % blockBytes !== 0 ||
    bytes % blockBytes !== 0
  ) {
    throw protocolError("managed disk geometry is invalid");
  }

  if (!Array.isArray(disk["chunks"])) {
    throw protocolError("disk.chunks must be an array");
  }
  const count = Math.ceil(bytes / chunkBytes);
  let previous = -1;
  const chunks = disk["chunks"].map((entry, position) => {
    const chunk = record(entry, `disk.chunks[${position}]`);
    exactKeys(chunk, [
      "index",
      "url",
      "bytes",
      "sha256",
      "encoding",
      "encodedBytes",
      "encodedSha256",
    ]);
    const index = integer(chunk["index"], `disk.chunks[${position}].index`, 0);
    if (index <= previous || index >= count) {
      throw protocolError(
        "managed disk chunk indexes must be unique and sorted",
      );
    }
    previous = index;
    const expectedBytes = Math.min(chunkBytes, bytes - index * chunkBytes);
    const artifact = decodeArtifact(
      chunk,
      manifestUrl,
      `disk.chunks[${position}]`,
      [
        "index",
        "encoding",
        "encodedBytes",
        "encodedSha256",
      ],
    );
    if (artifact.bytes !== expectedBytes) {
      throw protocolError(
        "managed disk chunk length does not match its index",
      );
    }
    if (string(chunk["encoding"], "chunk encoding") !== "gzip") {
      throw protocolError("managed disk chunks must use gzip");
    }
    const encodedSha256 = string(
      chunk["encodedSha256"],
      `disk.chunks[${position}].encodedSha256`,
    );
    if (!SHA256.test(encodedSha256)) {
      throw protocolError("managed disk encoded SHA-256 is invalid");
    }
    return {
      index,
      ...artifact,
      encoding: "gzip" as const,
      encodedBytes: integer(
        chunk["encodedBytes"],
        `disk.chunks[${position}].encodedBytes`,
        1,
        MAX_CHUNK_BYTES + 64 * 1024,
      ),
      encodedSha256,
    };
  });

  return { bytes, blockBytes: 4096, chunkBytes, chunks };
}

function decodeArtifact(
  value: unknown,
  manifestUrl: URL,
  label: string,
  extraKeys: readonly string[] = [],
): ManagedImageArtifact {
  const artifact = record(value, label);
  exactKeys(artifact, ["url", "bytes", "sha256", ...extraKeys]);
  const literal = nonempty(artifact["url"], `${label}.url`);
  const url = rememberArtifactURL(managedImageUrl(new URL(literal, manifestUrl)), literal);
  const sha256 = string(artifact["sha256"], `${label}.sha256`);
  if (!SHA256.test(sha256)) {
    throw protocolError(`${label}.sha256 must be lowercase SHA-256`);
  }
  return {
    url,
    bytes: integer(artifact["bytes"], `${label}.bytes`, 1),
    sha256,
  };
}

function nonempty(value: unknown, label: string): string {
  const decoded = string(value, label);
  if (decoded.length === 0) {
    throw protocolError(`${label} must not be empty`);
  }
  return decoded;
}

function digest(value: unknown, label: string): string {
  const decoded = string(value, label);
  if (!SHA256.test(decoded)) {
    throw protocolError(`${label} must be lowercase SHA-256`);
  }
  return decoded;
}

function decodeVcpus(value: unknown): 1 | 2 | 3 | 4 {
  switch (integer(value, "vcpus", 1, 4)) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    default:
      throw protocolError("managed image vCPU count is invalid");
  }
}

function catalogId(value: unknown, label: string): string {
  const decoded = nonempty(value, label);
  if (!CATALOG_ID.test(decoded)) {
    throw protocolError(`${label} is not a valid catalog identifier`);
  }
  return decoded;
}

function isPowerOfTwo(value: number): boolean {
  let remaining = value;
  while (remaining > 1 && remaining % 2 === 0) remaining /= 2;
  return remaining === 1;
}

/** The SDK's one trustworthy-origin rule: https, or http on this machine (*.localhost included). */
function isSecureUrl(url: URL): boolean {
  return isTrustworthyURL(url);
}
