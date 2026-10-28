import {
  exactKeys,
  integer,
  protocolError,
  record,
  string,
} from "./decode.js";
import { decodeEd25519Signature, verifyEd25519 } from "./ed25519.js";
import { managedImageUrl } from "./managed-image.js";
import { CORE_API_VERSION, JIT_API_VERSION, JIT_CONTEXT_VERSION } from "./core-abi.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_PACK_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_PACK_BYTES = 128 * 1024 * 1024;
const MAX_PACKS = 64;
const MAX_PACK_MEMBERS = 256;

export interface AotArtifact {
  readonly url: URL;
  readonly signedUrl: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type AotPackPhase =
  | "command"
  | "ready"
  | "first-request"
  | "warm-request"
  | "rebuild";

export interface AotPackArtifact extends AotArtifact {
  readonly phase: AotPackPhase;
  readonly sourceSha256: string;
  readonly memberCount: number;
  readonly score: number;
}

interface AotCatalogFields {
  readonly kind: "oxidevm-aot-catalog";
  readonly runtime: "system";
  readonly machineSha256: string;
  readonly command: string;
  readonly environment: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly workloadSha256: string;
  readonly trainingSha256: readonly [string, string, string, string, string];
  readonly index: AotArtifact;
  readonly packs: readonly AotPackArtifact[];
  readonly provenance: {
    readonly sbom: AotArtifact;
    readonly notices: AotArtifact;
    readonly correspondingSources: AotArtifact;
    readonly reproducibility: AotArtifact;
  };
  readonly signing: {
    readonly keyId: string;
    readonly signature: string;
  };
}

interface AotCpuCompatibility {
  readonly coreRuntimeKey: string;
  readonly ripMap: 2;
  readonly irMap: 5;
  readonly cpuProfile: "x86-64-v3";
  readonly mode: "long";
  readonly cpl: 3;
  readonly codeAttributes: number;
}

interface HistoricalAotCompatibility extends AotCpuCompatibility {
  readonly coreApi: 7;
  readonly jitApi: 51;
  readonly jitContext: 31;
}

interface CurrentAotCompatibility extends AotCpuCompatibility {
  readonly coreApi: typeof CORE_API_VERSION;
  readonly jitApi: typeof JIT_API_VERSION;
  readonly jitContext: typeof JIT_CONTEXT_VERSION;
  readonly capabilityRevision: 0 | 1;
}

type AotVersion =
  | { readonly schemaVersion: 1; readonly compatibility: HistoricalAotCompatibility }
  | { readonly schemaVersion: 2; readonly compatibility: CurrentAotCompatibility };

export type AotCatalog = AotCatalogFields & AotVersion;

export interface TrustedAotKey {
  readonly keyId: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
}

export function decodeAotCatalog(value: unknown, catalogUrl: URL): AotCatalog {
  const source = record(value, "AOT catalog");
  exactKeys(source, [
    "schemaVersion", "kind", "runtime", "machineSha256", "command",
    "environment", "workloadSha256", "trainingSha256", "compatibility",
    "index", "packs", "provenance", "signing",
  ]);
  const schemaVersion = integer(source["schemaVersion"], "AOT catalog schema");
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw protocolError("unsupported AOT catalog schema");
  }
  if (string(source["kind"], "AOT catalog kind") !== "oxidevm-aot-catalog") {
    throw protocolError("managed artifact is not an AOT catalog");
  }
  if (string(source["runtime"], "AOT catalog runtime") !== "system") {
    throw protocolError("AOT catalog runtime is unsupported");
  }
  const command = boundedText(source["command"], "AOT command", MAX_COMMAND_BYTES);
  const environment = decodeEnvironment(source["environment"]);
  const trainingSha256 = decodeTrainingDigests(source["trainingSha256"]);
  const version = decodeCompatibility(source["compatibility"], schemaVersion);
  const index = decodePlainArtifact(
    source["index"],
    catalogUrl,
    "AOT index",
    MAX_INDEX_BYTES,
  );
  const packs = decodePacks(source["packs"], catalogUrl);
  const provenance = decodeProvenance(source["provenance"], catalogUrl);
  const signing = decodeSigning(source["signing"]);
  return {
    ...version,
    kind: "oxidevm-aot-catalog",
    runtime: "system",
    machineSha256: digest(source["machineSha256"], "AOT machine identity"),
    command,
    environment,
    workloadSha256: digest(source["workloadSha256"], "AOT workload identity"),
    trainingSha256,
    index,
    packs,
    provenance,
    signing,
  };
}

export function canonicalAotCatalogBytes(
  catalog: AotCatalog,
): Uint8Array<ArrayBuffer> {
  const unsigned = catalogSigningValue(catalog);
  return new TextEncoder().encode(JSON.stringify(canonical(unsigned)));
}

function catalogSigningValue(catalog: AotCatalog): unknown {
  const artifact = (value: AotArtifact) => ({
    url: value.signedUrl,
    bytes: value.bytes,
    sha256: value.sha256,
  });
  return {
    schemaVersion: catalog.schemaVersion,
    kind: catalog.kind,
    runtime: catalog.runtime,
    machineSha256: catalog.machineSha256,
    command: catalog.command,
    environment: catalog.environment,
    workloadSha256: catalog.workloadSha256,
    trainingSha256: catalog.trainingSha256,
    compatibility: catalog.compatibility,
    index: artifact(catalog.index),
    packs: catalog.packs.map((pack) => ({
      ...artifact(pack),
      phase: pack.phase,
      sourceSha256: pack.sourceSha256,
      memberCount: pack.memberCount,
      score: pack.score,
    })),
    provenance: {
      sbom: artifact(catalog.provenance.sbom),
      notices: artifact(catalog.provenance.notices),
      correspondingSources: artifact(catalog.provenance.correspondingSources),
      reproducibility: artifact(catalog.provenance.reproducibility),
    },
    signing: { ...catalog.signing, signature: "" },
  };
}

export async function verifyAotCatalog(
  catalog: AotCatalog,
  trusted: TrustedAotKey,
): Promise<void> {
  if (trusted.keyId !== catalog.signing.keyId || trusted.publicKey.byteLength !== 32) {
    throw protocolError("AOT catalog signing key is not trusted");
  }
  await verifyEd25519(trusted.publicKey, catalog.signing.signature, canonicalAotCatalogBytes(catalog), "AOT catalog");
}

function decodeEnvironment(value: unknown): AotCatalog["environment"] {
  if (!Array.isArray(value) || value.length > MAX_ENVIRONMENT_ENTRIES) {
    throw protocolError("AOT environment must be a bounded array");
  }
  let previous = "";
  return value.map((item, index) => {
    const entry = record(item, `AOT environment[${index}]`);
    exactKeys(entry, ["name", "value"]);
    const name = string(entry["name"], `AOT environment[${index}].name`);
    if (!ENVIRONMENT_NAME.test(name) || name <= previous) {
      throw protocolError("AOT environment names must be valid, unique, and sorted");
    }
    previous = name;
    return {
      name,
      value: boundedText(
        entry["value"],
        `AOT environment[${index}].value`,
        MAX_ENVIRONMENT_VALUE_BYTES,
      ),
    };
  });
}

function decodeTrainingDigests(value: unknown): AotCatalog["trainingSha256"] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw protocolError("AOT training must contain exactly five sample identities");
  }
  return [
    digest(value[0], "AOT training[0]"),
    digest(value[1], "AOT training[1]"),
    digest(value[2], "AOT training[2]"),
    digest(value[3], "AOT training[3]"),
    digest(value[4], "AOT training[4]"),
  ];
}

function decodeCompatibility(value: unknown, schemaVersion: 1 | 2): AotVersion {
  const compatibility = record(value, "AOT compatibility");
  exactKeys(compatibility, [
    "coreRuntimeKey", "coreApi", "jitApi", "jitContext", "ripMap", "irMap", "cpuProfile",
    "mode", "cpl", "codeAttributes",
    ...(schemaVersion === 2 ? ["capabilityRevision"] : []),
  ]);
  if (
    integer(compatibility["coreApi"], "AOT core API") !== (schemaVersion === 1 ? 7 : CORE_API_VERSION)
    || integer(compatibility["jitApi"], "AOT JIT API") !== (schemaVersion === 1 ? 51 : JIT_API_VERSION)
    || integer(compatibility["jitContext"], "AOT JIT context") !== (schemaVersion === 1 ? 31 : JIT_CONTEXT_VERSION)
    || integer(compatibility["ripMap"], "AOT RIP map") !== 2
    || integer(compatibility["irMap"], "AOT IR map") !== 5
    || string(compatibility["cpuProfile"], "AOT CPU profile") !== "x86-64-v3"
    || string(compatibility["mode"], "AOT mode") !== "long"
    || integer(compatibility["cpl"], "AOT CPL") !== 3
  ) {
    throw protocolError("AOT catalog is incompatible with this runtime");
  }
  const cpu: AotCpuCompatibility = {
    coreRuntimeKey: digest(
      compatibility["coreRuntimeKey"],
      "AOT core runtime key",
    ),
    ripMap: 2,
    irMap: 5,
    cpuProfile: "x86-64-v3",
    mode: "long",
    cpl: 3,
    codeAttributes: integer(
      compatibility["codeAttributes"],
      "AOT code attributes",
      0,
      0xffff,
    ),
  };
  if (schemaVersion === 1) {
    return { schemaVersion: 1, compatibility: { ...cpu, coreApi: 7, jitApi: 51, jitContext: 31 } };
  }
  const capabilityRevision = integer(compatibility["capabilityRevision"], "AOT capability revision", 0, 1);
  return {
    schemaVersion: 2,
    compatibility: { ...cpu, coreApi: CORE_API_VERSION, jitApi: JIT_API_VERSION, jitContext: JIT_CONTEXT_VERSION,
      capabilityRevision: capabilityRevision === 1 ? 1 : 0,
    },
  };
}

function decodePacks(value: unknown, catalogUrl: URL): AotPackArtifact[] {
  if (!Array.isArray(value) || value.length > MAX_PACKS) {
    throw protocolError("AOT packs must be a bounded array");
  }
  const digests = new Set<string>();
  let totalBytes = 0;
  const packs = value.map((item, index) => {
    const pack = record(item, `AOT packs[${index}]`);
    exactKeys(pack, [
      "url", "bytes", "sha256", "phase", "sourceSha256", "memberCount", "score",
    ]);
    const artifact = decodeArtifactFields(
      pack,
      catalogUrl,
      `AOT packs[${index}]`,
      MAX_PACK_BYTES,
    );
    if (digests.has(artifact.sha256)) throw protocolError("AOT packs contain a duplicate digest");
    digests.add(artifact.sha256);
    totalBytes += artifact.bytes;
    const phase = decodePhase(pack["phase"], `AOT packs[${index}].phase`);
    const rawScore = pack["score"];
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0) {
      throw protocolError(`AOT packs[${index}].score must be a finite nonnegative number`);
    }
    return {
      ...artifact,
      phase,
      sourceSha256: digest(pack["sourceSha256"], `AOT packs[${index}].sourceSha256`),
      memberCount: integer(
        pack["memberCount"],
        `AOT packs[${index}].memberCount`,
        1,
        MAX_PACK_MEMBERS,
      ),
      score: rawScore,
    };
  });
  if (totalBytes > MAX_CATALOG_PACK_BYTES) {
    throw protocolError("AOT pack bytes exceed the catalog limit");
  }
  return packs;
}

function decodeProvenance(
  value: unknown,
  catalogUrl: URL,
): AotCatalog["provenance"] {
  const provenance = record(value, "AOT provenance");
  exactKeys(provenance, [
    "sbom", "notices", "correspondingSources", "reproducibility",
  ]);
  return {
    sbom: decodePlainArtifact(provenance["sbom"], catalogUrl, "AOT SBOM", MAX_INDEX_BYTES),
    notices: decodePlainArtifact(
      provenance["notices"],
      catalogUrl,
      "AOT notices",
      MAX_INDEX_BYTES,
    ),
    correspondingSources: decodePlainArtifact(
      provenance["correspondingSources"],
      catalogUrl,
      "AOT corresponding sources",
      MAX_INDEX_BYTES,
    ),
    reproducibility: decodePlainArtifact(
      provenance["reproducibility"],
      catalogUrl,
      "AOT reproducibility evidence",
      MAX_INDEX_BYTES,
    ),
  };
}

function decodeSigning(value: unknown): AotCatalog["signing"] {
  const signing = record(value, "AOT signing");
  exactKeys(signing, ["keyId", "signature"]);
  const keyId = string(signing["keyId"], "AOT signing key ID");
  if (!IDENTIFIER.test(keyId)) throw protocolError("AOT signing key ID is invalid");
  const signature = string(signing["signature"], "AOT signature");
  if (signature !== "") decodeEd25519Signature(signature, "AOT catalog");
  return { keyId, signature };
}

function decodePlainArtifact(
  value: unknown,
  baseUrl: URL,
  label: string,
  maximumBytes: number,
): AotArtifact {
  const artifact = record(value, label);
  exactKeys(artifact, ["url", "bytes", "sha256"]);
  return decodeArtifactFields(artifact, baseUrl, label, maximumBytes);
}

function decodeArtifactFields(
  artifact: Readonly<Record<string, unknown>>,
  baseUrl: URL,
  label: string,
  maximumBytes: number,
): AotArtifact {
  const signedUrl = string(artifact["url"], `${label}.url`);
  return {
    url: managedImageUrl(signedUrl, baseUrl),
    signedUrl,
    bytes: integer(artifact["bytes"], `${label}.bytes`, 1, maximumBytes),
    sha256: digest(artifact["sha256"], `${label}.sha256`),
  };
}

function decodePhase(value: unknown, label: string): AotPackPhase {
  const phase = string(value, label);
  if (
    phase !== "command"
    && phase !== "ready"
    && phase !== "first-request"
    && phase !== "warm-request"
    && phase !== "rebuild"
  ) {
    throw protocolError(`${label} is unsupported`);
  }
  return phase;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  const text = string(value, label);
  if (text.includes("\0") || new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw protocolError(`${label} is invalid`);
  }
  return text;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw protocolError(`${label} must be lowercase SHA-256`);
  return result;
}

function canonical(value: unknown): unknown {
  if (value instanceof URL) return value.href;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, canonical(item)]),
  );
}
