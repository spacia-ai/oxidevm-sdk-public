import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VMError } from "../../runtime/errors.js";
import { MANIFEST_INVALID } from "../../wasm/decode-support.js";
import { decodeModuleManifest, MAX_MANIFEST_BYTES } from "../../wasm/manifest.js";
import { MAX_ARTIFACT_BYTES } from "../../wasm/manifest-parts.js";
import type { ResolvedManifest } from "../../wasm/manifest-types.js";
import { servedName } from "../../wasm/served-names.js";
import { hashFile } from "../files.js";
import { abortIfRequested } from "../tools.js";
import { parseSums, releaseId, sha256Hex } from "./sums.js";

/** A file of a release, as measured: its name, size and digest. */
export interface Measured {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** A release whose files have been checked against `module.json` and `SHA256SUMS` and against each other. */
export interface VerifiedRelease {
  readonly id: string;
  readonly manifest: ResolvedManifest;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  readonly sumsBytes: Uint8Array<ArrayBuffer>;
  /** The adapter and every artifact (not `module.json` or `SHA256SUMS`). */
  readonly files: readonly Measured[];
}

function mismatch(message: string): never {
  throw new VMError("INVALID_ARGUMENT", `release ${message}`, { reason: MANIFEST_INVALID });
}

export { servedName };

/** What one release may weigh in all; its largest single file is bounded separately by `MAX_ARTIFACT_BYTES`. */
export const MAX_RELEASE_BYTES = 1024 ** 3;
/** A release has `module.json`, `SHA256SUMS`, the adapter and at most 64 artifacts, and a staged one adds a served copy of each script. */
const MAX_DIRECTORY_ENTRIES = 256;

/** The names a release must contain besides `SHA256SUMS`: `module.json`, the adapter and every artifact. */
export function releaseFileNames(manifest: ResolvedManifest): readonly string[] {
  return ["module.json", "adapter.mjs", ...manifest.artifacts.map(artifact => artifact.name)];
}

/**
 * Checks a release's three witnesses against each other: `module.json` is canonical, `SHA256SUMS` lists exactly the
 * release's files, and every measured file has the size `module.json` pins and the digest both documents give.
 */
export function verifyRelease(manifestBytes: Uint8Array<ArrayBuffer>, sumsBytes: Uint8Array<ArrayBuffer>, measured: readonly Measured[]): VerifiedRelease {
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) mismatch("module.json is too large");
  const manifest = decodeModuleManifest(manifestBytes);
  const listed = new Map(parseSums(sumsBytes).map(entry => [entry.name, entry.sha256]));
  const required = releaseFileNames(manifest);
  if (listed.size !== required.length || required.some(name => !listed.has(name))) mismatch(`SHA256SUMS must list exactly ${[...required].sort().join(", ")}`);
  if (listed.get("module.json") !== sha256Hex(manifestBytes)) mismatch("module.json does not match SHA256SUMS");
  const pins = new Map<string, { readonly sha256: string; readonly bytes: number }>([["adapter.mjs", manifest.adapter], ...manifest.artifacts.map(artifact => [artifact.name, artifact] as const)]);
  const files: Measured[] = [];
  for (const [name, pin] of pins) {
    const found = measured.find(entry => entry.name === name);
    if (found === undefined) return mismatch(`is missing ${name}`);
    if (found.bytes !== pin.bytes) mismatch(`${name} has ${String(found.bytes)} bytes where module.json pins ${String(pin.bytes)}`);
    if (found.sha256 !== pin.sha256 || listed.get(name) !== pin.sha256) mismatch(`${name} does not match its pinned sha256`);
    files.push(found);
  }
  for (const entry of measured) if (!pins.has(entry.name)) mismatch(`has an unlisted file ${entry.name}`);
  return { id: releaseId(sumsBytes), manifest, manifestBytes, sumsBytes, files };
}

export interface ReadOptions {
  /** The most the files of the directory may add up to; defaults to `MAX_RELEASE_BYTES`. */
  readonly maxReleaseBytes?: number;
  /**
   * The directory is a staged one, which also holds a `servedName` copy of every script, stylesheet and page the release
   * lists. Each copy must be present and identical to its original, and nothing else may be extra.
   */
  readonly servedCopies?: boolean;
}

/** Checks the extra files of a staged directory against the release: exactly one identical copy per rewritten file. */
function checkServedCopies(verified: VerifiedRelease, copies: readonly Measured[]): void {
  const originals = new Map(verified.files.filter(file => servedName(file.name) !== file.name).map(file => [servedName(file.name), file]));
  for (const copy of copies) {
    const original = originals.get(copy.name);
    if (original === undefined) mismatch(`has an unlisted file ${copy.name}`);
    else if (copy.sha256 !== original.sha256 || copy.bytes !== original.bytes) mismatch(`served copy ${copy.name} differs from ${original.name}`);
  }
  for (const served of originals.keys()) if (!copies.some(copy => copy.name === served)) mismatch(`is missing the served copy ${served}`);
}

/** Reads a directory laid out as a release (an author's build output), measuring each file by streaming it. */
export async function readReleaseDirectory(directory: string, signal?: AbortSignal, options: ReadOptions = {}): Promise<VerifiedRelease & { readonly directory: string }> {
  abortIfRequested(signal);
  const measured: Measured[] = [];
  let manifestBytes: Uint8Array<ArrayBuffer> | undefined, sumsBytes: Uint8Array<ArrayBuffer> | undefined;
  // Every bound is checked on the sizes alone, before anything is read or hashed: a sparse file is free to create and slow to hash.
  const names = await readdir(directory);
  if (names.length > MAX_DIRECTORY_ENTRIES) mismatch(`directory has more than ${String(MAX_DIRECTORY_ENTRIES)} entries`);
  const entries = await Promise.all(names.map(async name => ({ name, metadata: await lstat(join(directory, name)) })));
  const budget = options.maxReleaseBytes ?? MAX_RELEASE_BYTES;
  let total = 0;
  for (const { name, metadata } of entries) {
    if (!metadata.isFile()) mismatch(`directory entry ${name} is not a regular file`);
    if (metadata.size > MAX_ARTIFACT_BYTES) mismatch(`${name} is larger than the ${String(MAX_ARTIFACT_BYTES)} bytes a release file may have`);
    total += metadata.size;
    if (total > budget) mismatch(`directory holds more than ${String(budget)} bytes`);
  }
  for (const { name, metadata } of entries) {
    const path = join(directory, name);
    if (name === "module.json" || name === "SHA256SUMS") {
      if (metadata.size > MAX_MANIFEST_BYTES) mismatch(`${name} is too large`);
      const bytes = new Uint8Array(await readFile(path));
      if (name === "module.json") manifestBytes = bytes; else sumsBytes = bytes;
    } else measured.push({ name, sha256: await hashFile(path, signal), bytes: metadata.size });
    abortIfRequested(signal);
  }
  if (manifestBytes === undefined || sumsBytes === undefined) return mismatch("directory needs module.json and SHA256SUMS");
  if (options.servedCopies !== true) return { ...verifyRelease(manifestBytes, sumsBytes, measured), directory };
  const listed = new Set(releaseFileNames(decodeModuleManifest(manifestBytes)));
  const verified = verifyRelease(manifestBytes, sumsBytes, measured.filter(file => listed.has(file.name)));
  checkServedCopies(verified, measured.filter(file => !listed.has(file.name)));
  return { ...verified, directory };
}
