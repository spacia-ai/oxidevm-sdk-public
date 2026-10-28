import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { engineRelease, engineReleaseId } from "../engine.generated.js";
import { defaultImage } from "../default-image.js";
import { decodeImageLocation, decodeTrustedImageKey, defineImage } from "../image.js";
import type { ImageLocation, ImageRef } from "../image.js";
import type { RuntimeMode } from "../values.js";
import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import type { ProjectConfig } from "./contracts.js";
import { decodeBundleJSON } from "./bundle-files.js";
import { hash } from "./files.js";

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
export function validateProjectLock(value: unknown, input: ProjectConfig): ProjectLock {
  const lock = record(value, "project lock"); exactKeys(lock, ["schemaVersion", "mode", "sdkVersion", "cliVersion", "engine", "engineRelease", "image", "staging"]);
  const expected = createProjectLock(input);
  const image = record(lock["image"], "locked image"); exactKeys(image, ["mode", "manifestUrl", "manifestSHA256", "trust"]);
  const trust = record(image["trust"], "locked image trust"); const staging = record(lock["staging"], "locked staging");
  if (lock["schemaVersion"] !== 2 || lock["mode"] !== expected.mode || lock["sdkVersion"] !== expected.sdkVersion || lock["cliVersion"] !== expected.cliVersion || lock["engineRelease"] !== expected.engineRelease
    || hash(JSON.stringify(lock["engine"])) !== hash(JSON.stringify(expected.engine)) || image["mode"] !== expected.image.mode || image["manifestUrl"] !== expected.image.manifestUrl || image["manifestSHA256"] !== expected.image.manifestSHA256
    || trust["algorithm"] !== expected.image.trust.algorithm || trust["keyId"] !== expected.image.trust.keyId || trust["publicKey"] !== expected.image.trust.publicKey || Object.keys(trust).length !== 3
    || staging["publicDir"] !== expected.staging.publicDir || staging["assetBaseUrl"] !== expected.staging.assetBaseUrl || Object.keys(staging).length !== 2) throw new VMError("INVALID_ARGUMENT", "project lock differs from this exact SDK release; explicitly update the project dependency and lock");
  return expected;
}
