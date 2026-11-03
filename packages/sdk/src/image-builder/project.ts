import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { engineRelease, engineReleaseId } from "../engine.generated.js";
import { defaultImage } from "../default-image.js";
import { decodeImageLocation, decodeTrustedImageKey, defineImage } from "../image.js";
import type { ImageLocation, ImageRef } from "../image.js";
import { decodeSHA256 } from "../values.js";
import type { RuntimeMode, SHA256 } from "../values.js";
import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import type { ProjectConfig, ProjectLockIdentity } from "./contracts.js";
import { decodeBundleJSON } from "./bundle-files.js";

export interface ProjectLock {
  readonly schemaVersion: 2;
  readonly mode: RuntimeMode;
  readonly sdkVersion: string;
  readonly cliVersion: string;
  readonly engine: typeof engineRelease;
  readonly engineRelease: string;
  readonly image: ImageLocation<RuntimeMode>;
  readonly staging: { readonly publicDir: string; readonly assetBaseUrl: string };
}
let packageVersion: string | undefined;
/** The SDK's version is its own package.json version, which sits beside both src and dist. */
function sdkVersion(): string {
  packageVersion ??= string(record(decodeBundleJSON(new Uint8Array(readFileSync(new URL("../../package.json", import.meta.url)))), "SDK package manifest")["version"], "SDK package version");
  return packageVersion;
}
/** The exact SDK and engine release a project lock binds; the engine is named by its release ID. */
export function getSDKRelease(): { readonly sdkVersion: string; readonly engineRelease: string; readonly engine: typeof engineRelease } {
  return { sdkVersion: sdkVersion(), engineRelease: `sha256:${engineReleaseId}`, engine: structuredClone(engineRelease) };
}
export type ResolvedProjectConfig = Required<Omit<ProjectConfig, "image">> & Pick<ProjectConfig, "image">;

export function decodeProjectConfig(value: unknown): ResolvedProjectConfig {
  const input = record(value, "project configuration"); exactKeys(input, ["mode"], ["publicDir", "assetBaseUrl", "image"]);
  const mode = input["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("INVALID_ARGUMENT", "project mode must be system or userspace");
  const publicDir = input["publicDir"] === undefined ? "public" : string(input["publicDir"], "public directory");
  const assetBaseUrl = input["assetBaseUrl"] === undefined ? "/oxidevm/" : string(input["assetBaseUrl"], "asset base URL");
  if (publicDir.length === 0 || publicDir.length > 8192 || publicDir.includes("\0")) throw new VMError("INVALID_ARGUMENT", "invalid public directory");
  decodeImageLocation(`${assetBaseUrl}manifest.json`);
  if (!assetBaseUrl.endsWith("/") || new URL(assetBaseUrl, "https://project.invalid").search !== "") throw new VMError("INVALID_ARGUMENT", "assetBaseUrl must name a directory URL");
  let image: ImageRef<RuntimeMode> | undefined;
  if (input["image"] !== undefined) {
    const location = record(input["image"], "project image");
    exactKeys(location, ["mode", "manifestUrl", "manifestSHA256", "trust"]);
    if (location["mode"] !== mode) throw new VMError("INVALID_ARGUMENT", "project image must match the selected mode");
    image = defineImage({ mode, manifestUrl: decodeImageLocation(location["manifestUrl"]), manifestSHA256: string(location["manifestSHA256"], "image digest"), trust: decodeTrustedImageKey(location["trust"]) });
  }
  return { mode, publicDir, assetBaseUrl, ...(image === undefined ? {} : { image }) };
}
export async function loadProjectConfig(file: string): Promise<{ readonly directory: string; readonly config: ResolvedProjectConfig }> {
  const path = resolve(file); const location = pathToFileURL(path);
  let value: unknown;
  if (path.endsWith(".json")) value = decodeBundleJSON(new Uint8Array(await readFile(path)));
  else { const module: unknown = await import(location.href); value = record(module, "project module")["default"]; }
  return { directory: dirname(path), config: decodeProjectConfig(value) };
}
export function createProjectLock(input: ProjectConfig): ProjectLock {
  const config = decodeProjectConfig(input); const release = getSDKRelease();
  const image = config.image === undefined ? defaultImage(config.mode) : defineImage(config.image);
  const path = image.manifestUrl;
  if (config.image === undefined && !path.startsWith("/oxidevm/")) throw new VMError("PROTOCOL_ERROR", "official image lacks its release staging path");
  const reference = defineImage({ ...image, manifestUrl: config.image === undefined ? `${config.assetBaseUrl}${path.slice("/oxidevm/".length)}` : path });
  return { schemaVersion: 2, mode: config.mode, sdkVersion: release.sdkVersion, cliVersion: release.sdkVersion, engine: release.engine, engineRelease: release.engineRelease,
    image: { mode: reference.mode, manifestUrl: reference.manifestUrl, manifestSHA256: reference.manifestSHA256, trust: reference.trust }, staging: { publicDir: config.publicDir, assetBaseUrl: config.assetBaseUrl } };
}
/** The command that stages this release's assets and then rewrites a lock written for another release. */
const UPDATE_LOCK_COMMAND = "npx oxidevm assets install --update-lock";
const LOCKED_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const LOCKED_ENGINE = /^sha256:[0-9a-f]{64}$/u;

/** An existing lock's exact structure and the release it pins. Its other values are compared, never trusted. */
interface LockFields {
  readonly lock: Readonly<Record<string, unknown>>;
  readonly image: Readonly<Record<string, unknown>>;
  readonly trust: Readonly<Record<string, unknown>>;
  readonly staging: Readonly<Record<string, unknown>>;
  readonly identity: ProjectLockIdentity;
}
function lockedText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new VMError("PROTOCOL_ERROR", `project lock ${label} is invalid`);
  return value;
}
function lockedDigest(value: unknown): SHA256 {
  try { return decodeSHA256(value, "image digest"); } catch { throw new VMError("PROTOCOL_ERROR", "project lock image digest is invalid"); }
}
function readLock(value: unknown): LockFields {
  const lock = record(value, "project lock"); exactKeys(lock, ["schemaVersion", "mode", "sdkVersion", "cliVersion", "engine", "engineRelease", "image", "staging"]);
  const image = record(lock["image"], "locked image"); exactKeys(image, ["mode", "manifestUrl", "manifestSHA256", "trust"]);
  const trust = record(image["trust"], "locked image trust"); exactKeys(trust, ["algorithm", "keyId", "publicKey"]);
  const staging = record(lock["staging"], "locked staging"); exactKeys(staging, ["publicDir", "assetBaseUrl"]);
  // Only these values reach messages and reports, so they are decoded exactly first.
  const identity = { sdkVersion: lockedText(lock["sdkVersion"], LOCKED_VERSION, "SDK version"), engineRelease: lockedText(lock["engineRelease"], LOCKED_ENGINE, "engine release"), manifestSHA256: lockedDigest(image["manifestSHA256"]) };
  return { lock, image, trust, staging, identity };
}
/** The fields in which a lock differs from `expected`, named by their path in the file. */
function lockDifferences({ lock, image, trust, staging }: LockFields, expected: ProjectLock): readonly string[] {
  const same: readonly (readonly [string, boolean])[] = [
    ["schemaVersion", lock["schemaVersion"] === expected.schemaVersion], ["mode", lock["mode"] === expected.mode],
    ["sdkVersion", lock["sdkVersion"] === expected.sdkVersion], ["cliVersion", lock["cliVersion"] === expected.cliVersion],
    ["engine", JSON.stringify(lock["engine"]) === JSON.stringify(expected.engine)], ["engineRelease", lock["engineRelease"] === expected.engineRelease],
    ["image.mode", image["mode"] === expected.image.mode], ["image.manifestUrl", image["manifestUrl"] === expected.image.manifestUrl],
    ["image.manifestSHA256", image["manifestSHA256"] === expected.image.manifestSHA256],
    ["image.trust", trust["algorithm"] === expected.image.trust.algorithm && trust["keyId"] === expected.image.trust.keyId && trust["publicKey"] === expected.image.trust.publicKey],
    ["staging.publicDir", staging["publicDir"] === expected.staging.publicDir], ["staging.assetBaseUrl", staging["assetBaseUrl"] === expected.staging.assetBaseUrl],
  ];
  return same.filter(([, equal]) => !equal).map(([field]) => field);
}
/** The release a lock pins, as errors, `assets install` reports and the doctor name it. */
export function projectLockIdentity(lock: ProjectLock): ProjectLockIdentity {
  return { sdkVersion: lock.sdkVersion, engineRelease: lock.engineRelease, manifestSHA256: decodeSHA256(lock.image.manifestSHA256, "image digest") };
}
/** The release an existing lock pins and the fields in which it differs from `expected`; none when it matches. */
export function compareProjectLock(value: unknown, expected: ProjectLock): { readonly locked: ProjectLockIdentity; readonly fields: readonly string[] } {
  const fields = readLock(value);
  return { locked: fields.identity, fields: lockDifferences(fields, expected) };
}
/** The image a lock pins. `assets install --image` records an image the configuration does not name only there. */
export function lockedImage(value: unknown): ImageRef<RuntimeMode> {
  const { image } = readLock(value), mode = image["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "project lock image mode is invalid");
  return defineImage({ mode, manifestUrl: decodeImageLocation(image["manifestUrl"]), manifestSHA256: string(image["manifestSHA256"], "image digest"), trust: decodeTrustedImageKey(image["trust"]) });
}
function staleLock(locked: ProjectLockIdentity, installed: ProjectLockIdentity, fields: readonly string[]): VMError {
  const release = (lock: ProjectLockIdentity) => `SDK ${lock.sdkVersion}, engine ${lock.engineRelease}, image sha256:${lock.manifestSHA256}`;
  return new VMError("INVALID_ARGUMENT", `project lock oxidevm.lock.json does not match the installed SDK release and project configuration (differing fields: ${fields.join(", ")}): locked ${release(locked)}; installed ${release(installed)}; run \`${UPDATE_LOCK_COMMAND}\` to stage this release's assets and rewrite the lock (pass --image and --trust again for an image the project configuration does not name)`,
    { reason: "project-lock-stale", fields: [...fields], locked, installed });
}
/** An existing lock must be the one this release writes for `input`; one that differs says how to update it. */
export function validateProjectLock(value: unknown, input: ProjectConfig): ProjectLock {
  const read = readLock(value), expected = createProjectLock(input), fields = lockDifferences(read, expected);
  if (fields.length > 0) throw staleLock(read.identity, projectLockIdentity(expected), fields);
  return expected;
}
