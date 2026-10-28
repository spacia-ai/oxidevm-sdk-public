import { chmod, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { engineDownload, engineLicense, engineRelease, engineReleaseId } from "../engine.generated.js";
import { boolean, exactKeys, integer, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { atomicBundle } from "./atomic.js";
import { downloadArtifact, privateDownloadToken } from "./download.js";
import { copyVerified, hash, hashFile } from "./files.js";
import { abortIfRequested } from "./tools.js";
import { pinnedEngineCompliance } from "../engine-compliance.js";

// The SDK contains no engine (ADR 0019). It pins one content-addressed engine release, built by the
// engine repository, and this module finds a verified copy of it: an explicit directory,
// OXIDEVM_ENGINE_DIR, the local engine cache, or a download from the private release channel.
// The release ID vouches for release.json and the modules; the engine LICENSE is not part of
// release.json (the engine may amend its text without a new release), so the pin records its
// size and SHA-256 separately and every source must carry exactly that text.

/** The modules of an engine release in release.json order, each with the runtime mode it serves. */
const MODULES = [
  { name: "oxidevm_core.wasm", mode: "system" },
  { name: "oxidevm_core_shared.wasm", mode: "system" },
  { name: "oxidevm_netstack.wasm", mode: "system" },
  { name: "oxidevm_userspace.wasm", mode: "userspace" },
] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RELEASE_ASSET_PATH = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/[1-9][0-9]*$/u;
const MAX_RELEASE_JSON_BYTES = 64 * 1024;
const MAX_MODULE_BYTES = 256 * 1024 ** 2;
const MAX_LICENSE_BYTES = 1024 ** 2;

export type EngineModuleName = (typeof MODULES)[number]["name"];
export type EngineFileName = "release.json" | "LICENSE" | EngineModuleName;

/** release.json, schema 3: what the engine repository's release builder writes. */
export interface EngineReleaseManifest {
  readonly schemaVersion: 3;
  readonly engineSource: { readonly commit: string; readonly dirty: boolean; readonly nativeInputsSHA256: string };
  readonly identities: { readonly coreApi: number; readonly jitAbi: number; readonly userspaceApi: number; readonly netstackApi: number };
  readonly artifacts: readonly { readonly name: EngineModuleName; readonly mode: (typeof MODULES)[number]["mode"]; readonly bytes: number; readonly sha256: string }[];
}
/**
 * Where a release can be downloaded: Spacia's public CDN (ADR 0021), each file at
 * `<baseUrl><name>`, or the private release channel's exact asset URLs (a token is needed).
 */
export type EngineDownload =
  | { readonly kind: "cdn"; readonly release: string; readonly baseUrl: string }
  | { readonly kind: "github-release-assets"; readonly release: string; readonly assets: Readonly<Record<EngineFileName, string>> };
/** The engine LICENSE text a pin requires, which release.json does not cover. */
export interface EngineLicensePin { readonly bytes: number; readonly sha256: string }
/** One engine release: release.json's SHA-256 (the release ID), its decoded content, its LICENSE and where to download it. */
export interface EngineReleasePin {
  readonly id: string;
  readonly manifest: EngineReleaseManifest;
  readonly manifestBytes: number;
  readonly license: EngineLicensePin;
  readonly download: EngineDownload | null;
}
export interface ResolveEngineOptions {
  /** A local copy of the pinned release, such as the engine repository's `.cache/engine/releases/<id>`. */
  readonly engineDir?: string;
  readonly engineComplianceDir?: string;
  /** Where verified releases are kept by ID; defaults to `defaultEngineCacheDir()`. */
  readonly cacheDir?: string;
  readonly signal?: AbortSignal;
}

function failure(message: string, detail?: Readonly<Record<string, unknown>>): VMError {
  return new VMError("CORE_LOAD_FAILED", message, detail);
}
function reason(error: unknown): string { return error instanceof Error ? error.message : "invalid value"; }
function matching(value: unknown, label: string, pattern: RegExp): string {
  const text = string(value, label);
  if (!pattern.test(text)) throw new TypeError(`${label} is not in its required lowercase hexadecimal form`);
  return text;
}

/** release.json as the engine writes it: two-space JSON in schema order, then one newline. */
function canonicalBytes(manifest: EngineReleaseManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function decodeManifest(value: unknown): EngineReleaseManifest {
  const manifest = record(value, "release.json");
  exactKeys(manifest, ["schemaVersion", "engineSource", "identities", "artifacts"]);
  if (manifest["schemaVersion"] !== 3) throw new TypeError(`schema version ${String(manifest["schemaVersion"])} is not 3`);
  const source = record(manifest["engineSource"], "engineSource");
  exactKeys(source, ["commit", "dirty", "nativeInputsSHA256"]);
  const identities = record(manifest["identities"], "identities");
  exactKeys(identities, ["coreApi", "jitAbi", "userspaceApi", "netstackApi"]);
  const artifacts: unknown = manifest["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length !== MODULES.length) throw new TypeError(`artifacts must list the ${String(MODULES.length)} engine modules`);
  const listed: readonly unknown[] = artifacts;
  const identity = (key: string) => integer(identities[key], `identities.${key}`, 0, 0xffff_ffff);
  return {
    schemaVersion: 3,
    engineSource: {
      commit: matching(source["commit"], "engineSource.commit", GIT_COMMIT),
      dirty: boolean(source["dirty"], "engineSource.dirty"),
      nativeInputsSHA256: matching(source["nativeInputsSHA256"], "engineSource.nativeInputsSHA256", SHA256),
    },
    identities: { coreApi: identity("coreApi"), jitAbi: identity("jitAbi"), userspaceApi: identity("userspaceApi"), netstackApi: identity("netstackApi") },
    artifacts: MODULES.map(({ name, mode }, index) => {
      const artifact = record(listed[index], `artifacts[${String(index)}]`);
      exactKeys(artifact, ["name", "mode", "bytes", "sha256"]);
      if (artifact["name"] !== name || artifact["mode"] !== mode) throw new TypeError(`artifacts[${String(index)}] must be ${name} for ${mode}`);
      return { name, mode, bytes: integer(artifact["bytes"], `${name} bytes`, 1, MAX_MODULE_BYTES), sha256: matching(artifact["sha256"], `${name} sha256`, SHA256) };
    }),
  };
}

/** Decodes an untrusted release.json, which must be byte for byte the canonical form its ID hashes. */
export function decodeEngineRelease(bytes: Uint8Array): EngineReleaseManifest {
  if (bytes.byteLength > MAX_RELEASE_JSON_BYTES) throw failure(`release.json exceeds ${String(MAX_RELEASE_JSON_BYTES)} bytes`);
  let manifest: EngineReleaseManifest;
  try { manifest = decodeManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error: unknown) { throw failure(`release.json is not a schema-3 engine release: ${reason(error)}`); }
  if (!Buffer.from(canonicalBytes(manifest)).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) {
    throw failure("release.json is not in the engine's canonical form (two-space JSON in schema order, then one newline)");
  }
  return manifest;
}

function assetUrl(value: unknown, name: EngineFileName): string {
  const text = string(value, `${name} asset URL`);
  let url: URL;
  try { url = new URL(text); } catch { throw new TypeError(`${name} asset URL is not a URL`); }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port !== "" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.href !== text || !RELEASE_ASSET_PATH.test(url.pathname)) {
    throw new TypeError(`${name} must be a GitHub release-asset API URL`);
  }
  return text;
}
function decodeAssetUrls(value: unknown): Readonly<Record<EngineFileName, string>> {
  const assets = record(value, "engine release assets");
  exactKeys(assets, ["release.json", "LICENSE", ...MODULES.map(module => module.name)]);
  return {
    "release.json": assetUrl(assets["release.json"], "release.json"),
    LICENSE: assetUrl(assets["LICENSE"], "LICENSE"),
    "oxidevm_core.wasm": assetUrl(assets["oxidevm_core.wasm"], "oxidevm_core.wasm"),
    "oxidevm_core_shared.wasm": assetUrl(assets["oxidevm_core_shared.wasm"], "oxidevm_core_shared.wasm"),
    "oxidevm_netstack.wasm": assetUrl(assets["oxidevm_netstack.wasm"], "oxidevm_netstack.wasm"),
    "oxidevm_userspace.wasm": assetUrl(assets["oxidevm_userspace.wasm"], "oxidevm_userspace.wasm"),
  };
}

/** Decodes the publisher's assets.json: exactly the release's six files, each at a release-asset URL. */
export function decodeEngineAssetUrls(value: unknown): Readonly<Record<EngineFileName, string>> {
  try { return decodeAssetUrls(value); }
  catch (error: unknown) { throw failure(`engine release assets are invalid: ${reason(error)}`); }
}

/** Decodes a recorded download location, `null` when the pin has none. */
export function decodeEngineDownload(value: unknown, releaseId: string): EngineDownload | null {
  if (value === null) return null;
  try {
    const download = record(value, "engine download");
    const release = `engine-${releaseId}`;
    if (download["release"] !== release) throw new TypeError(`it must name release ${release}`);
    if (download["kind"] === "cdn") {
      exactKeys(download, ["kind", "release", "baseUrl"]);
      return { kind: "cdn", release, baseUrl: cdnBaseUrl(download["baseUrl"], releaseId) };
    }
    exactKeys(download, ["kind", "release", "assets"]);
    if (download["kind"] !== "github-release-assets") throw new TypeError("its kind must be cdn or github-release-assets");
    return { kind: "github-release-assets", release, assets: decodeAssetUrls(download["assets"]) };
  } catch (error: unknown) { throw failure(`engine download location is invalid: ${reason(error)}`); }
}

/** A CDN location: an https directory URL ending in /engine/<release id>/, with nothing else. */
export function cdnBaseUrl(value: unknown, releaseId: string): string {
  const text = string(value, "engine CDN base URL");
  let url: URL;
  try { url = new URL(text); } catch { throw new TypeError("engine CDN base URL is not a URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.href !== text || !url.pathname.endsWith(`/engine/${releaseId}/`)) {
    throw new TypeError(`engine CDN base URL must be an https directory ending in /engine/${releaseId}/`);
  }
  return text;
}

/** Decodes a recorded LICENSE identity: a nonempty size within its bound and a SHA-256. */
export function decodeEngineLicense(value: unknown): EngineLicensePin {
  try {
    const license = record(value, "engine LICENSE pin");
    exactKeys(license, ["bytes", "sha256"]);
    return { bytes: integer(license["bytes"], "LICENSE bytes", 1, MAX_LICENSE_BYTES), sha256: matching(license["sha256"], "LICENSE sha256", SHA256) };
  } catch (error: unknown) { throw failure(`engine LICENSE pin is invalid: ${reason(error)}`); }
}

/** The identity of `<directory>/LICENSE`, which a pin records beside release.json. */
export async function readEngineLicense(directory: string, signal?: AbortSignal): Promise<EngineLicensePin> {
  const path = join(directory, "LICENSE");
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata?.isFile() !== true || metadata.size < 1 || metadata.size > MAX_LICENSE_BYTES) {
    throw failure(`${path} must be the engine LICENSE: a regular file of 1 to ${String(MAX_LICENSE_BYTES)} bytes`);
  }
  return { bytes: metadata.size, sha256: await hashFile(path, signal) };
}

/** Pins the release whose exact release.json bytes are `releaseJson`, with the LICENSE it must carry. */
export function pinEngineRelease(releaseJson: Uint8Array, license: EngineLicensePin, download: EngineDownload | null): EngineReleasePin {
  const manifest = decodeEngineRelease(releaseJson);
  const id = hash(releaseJson);
  if (download !== null && download.release !== `engine-${id}`) throw failure(`the download location names ${download.release}, not engine-${id}`);
  return { id, manifest, manifestBytes: releaseJson.byteLength, license: decodeEngineLicense(license), download };
}

let pinned: EngineReleasePin | undefined;
/** The release this SDK was built against (`engine.generated.ts`, written by `pnpm engine:pin`). */
export function pinnedEngineRelease(): EngineReleasePin {
  if (pinned !== undefined) return pinned;
  const pin = pinEngineRelease(new TextEncoder().encode(`${JSON.stringify(engineRelease, null, 2)}\n`), decodeEngineLicense(engineLicense), decodeEngineDownload(engineDownload, engineReleaseId));
  if (pin.id !== engineReleaseId) throw failure(`this SDK's engine pin is inconsistent: release.json hashes to ${pin.id}, not ${engineReleaseId}; re-pin it with pnpm engine:pin`);
  pinned = pin;
  return pin;
}

/** `$XDG_CACHE_HOME/oxidevm/engine`, or `~/.cache/oxidevm/engine` when it is unset, empty or relative (as the XDG specification requires). */
export function defaultEngineCacheDir(): string {
  const configured = process.env["XDG_CACHE_HOME"];
  return join(configured !== undefined && isAbsolute(configured) ? configured : join(homedir(), ".cache"), "oxidevm", "engine");
}

/** Every file of the release with the identity the pin requires: release.json (its ID), the modules it names, the LICENSE. */
function pinnedFiles(pin: EngineReleasePin): readonly { readonly name: EngineFileName; readonly bytes: number; readonly sha256: string }[] {
  return [{ name: "release.json", bytes: pin.manifestBytes, sha256: pin.id }, ...pin.manifest.artifacts, { name: "LICENSE", ...pin.license }];
}
async function fileProblem(directory: string, file: { readonly name: EngineFileName; readonly bytes: number; readonly sha256: string }, signal?: AbortSignal): Promise<string | undefined> {
  const path = join(directory, file.name);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return `${file.name} is not a regular file`;
    if (metadata.size !== file.bytes) return `${file.name} has ${String(metadata.size)} bytes where the pin requires ${String(file.bytes)}`;
    return await hashFile(path, signal) === file.sha256 ? undefined : `${file.name} differs from its pinned SHA-256`;
  } catch (error: unknown) {
    abortIfRequested(signal);
    if (error instanceof VMError && error.code === "ABORTED") throw error;
    return `${file.name} is missing or unreadable`;
  }
}
/** Why `directory` is not exactly the pinned release, or `undefined` when it is. */
async function releaseProblem(directory: string, pin: EngineReleasePin, signal?: AbortSignal): Promise<string | undefined> {
  for (const file of pinnedFiles(pin)) {
    abortIfRequested(signal);
    const problem = await fileProblem(directory, file, signal);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Proves `directory` holds the pinned release: release.json hashes to its ID, and each module and the LICENSE have their pinned size and SHA-256. */
export async function verifyEngineRelease(directory: string, pin: EngineReleasePin, signal?: AbortSignal): Promise<void> {
  const problem = await releaseProblem(directory, pin, signal);
  if (problem !== undefined) throw failure(`${directory} is not engine release ${pin.id}: ${problem}`, { releaseId: pin.id });
}

function unavailable(pin: EngineReleasePin, invalidCache: string | undefined): VMError {
  const cache = invalidCache === undefined ? "" : ` (the cached copy at ${invalidCache} does not match it)`;
  const sources = pin.download === null
    ? "pass --engine-dir or set OXIDEVM_ENGINE_DIR to a local copy of it; this SDK build records no download location for it"
    : pin.download.kind === "cdn" ? `pass --engine-dir, set OXIDEVM_ENGINE_DIR, or make ${pin.download.baseUrl} reachable`
      : "pass --engine-dir, set OXIDEVM_ENGINE_DIR, or provide OXIDEVM_DOWNLOAD_TOKEN for the private release";
  return failure(`engine release ${pin.id} is unavailable${cache}: ${sources}`, { releaseId: pin.id });
}

async function downloadRelease(pin: EngineReleasePin, download: EngineDownload, target: string, signal?: AbortSignal): Promise<void> {
  const current: { asset: EngineFileName } = { asset: "release.json" };
  try {
    await atomicBundle(target, async staging => {
      for (const file of pinnedFiles(pin)) {
        current.asset = file.name;
        const url = download.kind === "cdn" ? new URL(file.name, download.baseUrl).href : download.assets[file.name];
        await downloadArtifact({ url, bytes: file.bytes, sha256: file.sha256 }, join(staging, file.name), signal);
      }
      await verifyEngineRelease(staging, pin, signal);
    }, signal);
  } catch (error: unknown) {
    // An abort while a request or read is pending rejects with the signal's DOMException, not ABORTED.
    abortIfRequested(signal);
    if (error instanceof VMError && error.code === "ABORTED") throw error;
    const cause = error instanceof VMError ? { ...error.detail, downloadError: error.code } : {};
    throw failure(`engine release ${pin.id} could not be downloaded from ${download.release}: ${current.asset}: ${reason(error)}`, { ...cause, releaseId: pin.id, asset: current.asset });
  }
}

/**
 * The directory of a verified copy of the engine release. Sources, in order: `engineDir`, then
 * OXIDEVM_ENGINE_DIR (either is used or rejected, never skipped), then `<cacheDir>/<release ID>`,
 * then a download of the private release into that cache entry with OXIDEVM_DOWNLOAD_TOKEN or
 * GH_TOKEN. The download is staged beside the entry and renamed into place once verified.
 */
async function resolveEnginePayloadDirectory(options: ResolveEngineOptions, pin: EngineReleasePin): Promise<string> {
  const { signal } = options;
  abortIfRequested(signal);
  const environment = process.env["OXIDEVM_ENGINE_DIR"];
  const selected = options.engineDir ?? (environment === "" ? undefined : environment);
  if (selected !== undefined) {
    const directory = resolve(selected);
    await verifyEngineRelease(directory, pin, signal);
    return directory;
  }
  const cached = join(resolve(options.cacheDir ?? defaultEngineCacheDir()), pin.id);
  const present = await lstat(cached).then(() => true, () => false);
  if (present && await releaseProblem(cached, pin, signal) === undefined) return cached;
  // The public CDN needs no token; the private release channel does.
  if (pin.download === null || (pin.download.kind === "github-release-assets" && privateDownloadToken() === undefined)) throw unavailable(pin, present ? cached : undefined);
  await downloadRelease(pin, pin.download, cached, signal);
  return cached;
}

export async function resolveEngineDirectory(options: ResolveEngineOptions = {}, pin: EngineReleasePin = pinnedEngineRelease()): Promise<string> {
  const directory = await resolveEnginePayloadDirectory(options, pin);
  const compliance = pin.id === engineReleaseId ? pinnedEngineCompliance() : null;
  if (compliance !== null) {
    const { resolveEngineCompliance } = await import("./engine-compliance.js");
    await resolveEngineCompliance(compliance, pin.id, { engineDirectory: directory, ...(options.engineComplianceDir === undefined ? {} : { directory: options.engineComplianceDir }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  }
  return directory;
}

/**
 * Copies the verified release in `source` to `target` (replacing it atomically); returns the number
 * of files. Staged files are world-readable (0644) whatever their source mode: downloads are created
 * 0600 and a copy would carry that into an application's public directory.
 */
export async function copyEngineRelease(source: string, target: string, pin: EngineReleasePin, signal?: AbortSignal, complianceDirectory?: string): Promise<number> {
  await verifyEngineRelease(source, pin, signal);
  const files = pinnedFiles(pin);
  const reference = pin.id === engineReleaseId ? pinnedEngineCompliance() : null;
  const metadata = reference === null ? undefined : await import("./engine-compliance.js");
  const legal = reference === null || metadata === undefined ? undefined : await metadata.resolveEngineCompliance(reference, pin.id, { engineDirectory: source, ...(complianceDirectory === undefined ? {} : { directory: complianceDirectory }), ...(signal === undefined ? {} : { signal }) });
  let complianceFiles = 0;
  await atomicBundle(target, async staging => {
    for (const file of files) {
      await copyVerified(join(source, file.name), join(staging, file.name), file, signal);
      await chmod(join(staging, file.name), 0o644);
    }
    if (legal !== undefined && reference !== null && metadata !== undefined) complianceFiles = await metadata.copyEngineCompliance(legal, join(staging, "compliance", reference.sha256), reference, pin.id, signal);
  }, signal);
  return files.length + complianceFiles;
}
