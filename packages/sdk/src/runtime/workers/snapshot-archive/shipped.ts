import type {RuntimeMode} from "../../../values.js";
import { exactKeys, record, string } from "../../decode.js";
import { verifyEd25519 } from "../../ed25519.js";
import { VMError, type VMErrorCode } from "../../errors.js";
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  type ObjectRef,
  SNAPSHOT_SCHEMA,
  type SnapshotManifest,
  USERSPACE_SNAPSHOT_SCHEMA,
} from "../snapshot-manifest.js";
import { backupObjectsOf, MAX_BACKUP_MANIFEST_BYTES } from "./manifest.js";
import { decodeShippedTransport, type ShippedTransport, transportBytes } from "./shipped-transport.js";

export const SHIPPED_FORMAT = "oxidevm-shipped-snapshot";
/** A shipped restore point whose chunks hold all of it. */
export const SHIPPED_FORMAT_VERSION = 1;
/** A shipped Userspace start that leaves out its image files (`transport`). */
export const SHIPPED_TRANSPORT_FORMAT_VERSION = 2;
/** No genuine restore point was captured before this. */
const EARLIEST_CAPTURE_UNIX_MS = Date.UTC(2020, 0, 1);
const CLOCK_SKEW_MILLISECONDS = 24 * 3_600_000;

/** Why a shipped restore point was refused; its reason is `shipped-<problem>`. */
export type ShippedProblem = "untrusted" | "signature-invalid" | "newer" | "older" | "incompatible" | "damaged" | "unavailable";

const CODES: Readonly<Record<ShippedProblem, VMErrorCode>> = {
  untrusted: "PERMISSION_DENIED",
  "signature-invalid": "PERMISSION_DENIED",
  newer: "SNAPSHOT_VERSION",
  older: "SNAPSHOT_VERSION",
  incompatible: "INVALID_ARGUMENT",
  damaged: "STORAGE_ERROR",
  unavailable: "STORAGE_ERROR",
};

/**
 * A restore point shipped with a profile (ADR 0014, Release 2): published unpacked beside the
 * profile as `snapshots/<name>/manifest.json` and `chunks/<sha256>.gz`, signed with Ed25519.
 */
export interface ShippedManifest {
  readonly name: string;
  readonly snapshot: SnapshotManifest;
  /** The objects its chunks hold, in hash order; the image supplies its kernel and initrd. */
  readonly objects: readonly ObjectRef[];
  /** Present when the chunks leave out image files: the payload stream is rebuilt from them. */
  readonly transport?: ShippedTransport;
}

export interface ShippedExpectation {
  /** The name the profile lists it under. */
  readonly name: string;
  readonly trusted: { readonly keyId: string; readonly publicKey: Uint8Array<ArrayBuffer> };
  /** The profile image it must run on. */
  readonly image: {readonly mode?:RuntimeMode; readonly id: string; readonly version: string; readonly identity: string };
  readonly nowUnixMs: number;
}

export function shippedError(problem: ShippedProblem, message: string): VMError {
  return new VMError(CODES[problem], message, { reason: `shipped-${problem}` });
}

/** Canonical bytes of a published manifest: fixed key order, no whitespace. */
export function encodeShippedManifest(
  name: string,
  snapshot: SnapshotManifest,
  signing: { readonly keyId: string; readonly signature: string },
  transport?: ShippedTransport,
): Uint8Array<ArrayBuffer> {
  const encoded = new TextDecoder().decode(encodeSnapshotManifest(snapshot));
  const version = transport === undefined ? SHIPPED_FORMAT_VERSION : SHIPPED_TRANSPORT_FORMAT_VERSION;
  return new TextEncoder().encode(
    `{"format":${JSON.stringify(SHIPPED_FORMAT)},"formatVersion":${String(version)},"name":${JSON.stringify(name)},` +
    `"snapshot":${encoded},${transport === undefined ? "" : `"transport":${transportBytes(transport)},`}` +
    `"signing":{"keyId":${JSON.stringify(signing.keyId)},"signature":${JSON.stringify(signing.signature)}}}`,
  );
}

/** What a shipped manifest's signature covers: its canonical bytes with an empty signature. */
export function shippedSigningBytes(name: string, snapshot: SnapshotManifest, keyId: string, transport?: ShippedTransport): Uint8Array<ArrayBuffer> {
  return encodeShippedManifest(name, snapshot, { keyId, signature: "" }, transport);
}

/**
 * Verifies a downloaded shipped manifest: a version this browser reads, a signature by the
 * trusted key over its canonical bytes, then the name, kind, capture time and image `expected`
 * names. The signature is checked against what was decoded, so no field can change unsigned.
 */
export async function verifyShippedManifest(bytes: Uint8Array, expected: ShippedExpectation): Promise<ShippedManifest> {
  const manifest = readVersioned(bytes);
  let name: string;
  let keyId: string;
  let signature: string;
  let snapshot: SnapshotManifest;
  let transport: ShippedTransport | undefined;
  try {
    const transported = manifest["formatVersion"] === SHIPPED_TRANSPORT_FORMAT_VERSION;
    exactKeys(manifest, ["format", "formatVersion", "name", "snapshot", ...(transported ? ["transport"] : []), "signing"]);
    const signing = record(manifest["signing"], "shipped signing");
    exactKeys(signing, ["keyId", "signature"]);
    name = string(manifest["name"], "shipped name");
    keyId = string(signing["keyId"], "shipped key id");
    signature = string(signing["signature"], "shipped signature");
    snapshot = decodeSnapshotManifest(manifest["snapshot"]);
    if (transported) {
      if (snapshot.schema !== USERSPACE_SNAPSHOT_SCHEMA) throw new VMError("PROTOCOL_ERROR", "only a Userspace start leaves out image files");
      transport = decodeShippedTransport(manifest["transport"], snapshot.payloads);
    }
  } catch (error) {
    if (error instanceof VMError && error.detail?.["reason"] === "snapshot-older-format") {
      throw shippedError("older", "the shipped restore point is from an older OxideVM");
    }
    throw shippedError("damaged", "the shipped restore point's description is invalid");
  }
  if (keyId !== expected.trusted.keyId) throw shippedError("untrusted", "the shipped restore point is signed by an unknown key");
  try {
    await verifyEd25519(expected.trusted.publicKey, signature, shippedSigningBytes(name, snapshot, keyId, transport), "Shipped restore point");
  } catch {
    throw shippedError("signature-invalid", "the shipped restore point's signature does not match");
  }
  const latest = expected.nowUnixMs + CLOCK_SKEW_MILLISECONDS;
  if (
    name !== expected.name || snapshot.kind !== "shipped"
    || !(snapshot.capturedAtUnixMs >= EARLIEST_CAPTURE_UNIX_MS && snapshot.capturedAtUnixMs <= latest)
  ) {
    throw shippedError("damaged", "the shipped restore point is not the one its profile lists");
  }
  if(expected.image.mode!==undefined&&expected.image.mode!==(snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA?"userspace":"system")) throw shippedError("incompatible","the shipped start belongs to another runtime");
  const disk = snapshot.schema === 2 ? snapshot.disk : undefined;
  if (
    snapshot.schema === USERSPACE_SNAPSHOT_SCHEMA
      ? snapshot.rootfs.rootTreeSha256 !== expected.image.identity || snapshot.rootfs.image.id !== expected.image.id || snapshot.rootfs.image.version !== expected.image.version
      : disk?.origin !== "managed" || disk.baseIdentity !== expected.image.identity || disk.image.id !== expected.image.id || disk.image.version !== expected.image.version
  ) {
    throw shippedError("incompatible", "the shipped restore point belongs to another image");
  }
  return transport === undefined ? { name, snapshot, objects: backupObjectsOf(snapshot) } : { name, snapshot, objects: transportedObjects(snapshot, transport), transport };
}

/** What a transported start downloads: every object but the payload stream, then the literal stream. */
function transportedObjects(snapshot: SnapshotManifest, transport: ShippedTransport): ObjectRef[] {
  if (snapshot.schema !== USERSPACE_SNAPSHOT_SCHEMA) throw shippedError("damaged", "only a Userspace start leaves out image files");
  const objects = new Map(backupObjectsOf({ ...snapshot, payloads: { bytes: 0, chunks: [] } }).map(object => [object.sha256, object]));
  for (const chunk of transport.literal.chunks) {
    const known = objects.get(chunk.sha256);
    if (known !== undefined && known.bytes !== chunk.bytes) throw shippedError("damaged", "a shipped start gives one object two sizes");
    objects.set(chunk.sha256, { sha256: chunk.sha256, bytes: chunk.bytes });
  }
  return [...objects.values()].sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
}

/** The manifest's fields once its format and versions are ones this browser reads. */
function readVersioned(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  if (bytes.byteLength > MAX_BACKUP_MANIFEST_BYTES) throw shippedError("damaged", "the shipped restore point's description is too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw shippedError("damaged", "the shipped restore point's description is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw shippedError("damaged", "the shipped restore point's description is invalid");
  }
  const manifest = record(value, "shipped manifest");
  if (manifest["format"] !== SHIPPED_FORMAT) throw shippedError("damaged", "this is not a shipped restore point");
  const version = manifest["formatVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw shippedError("damaged", "the shipped restore point's format version is invalid");
  }
  const snapshot = manifest["snapshot"];
  const schema: unknown = typeof snapshot === "object" && snapshot !== null && "schema" in snapshot ? snapshot.schema : undefined;
  if (version > SHIPPED_TRANSPORT_FORMAT_VERSION || (typeof schema === "number" && schema > USERSPACE_SNAPSHOT_SCHEMA)) {
    throw shippedError("newer", "the shipped restore point needs a newer OxideVM");
  }
  if (version < SHIPPED_FORMAT_VERSION || (typeof schema === "number" && schema < SNAPSHOT_SCHEMA)) {
    throw shippedError("older", "the shipped restore point is from an older OxideVM");
  }
  return manifest;
}
