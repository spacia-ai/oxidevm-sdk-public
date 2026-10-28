import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VMError } from "../runtime/errors.js";
import { atomicBundle } from "./atomic.js";
import { readBundleFile } from "./bundle-files.js";
import { downloadArtifact } from "./download.js";
import { defaultEngineCacheDir } from "./engine-source.js";
import { hash } from "./files.js";
import { decodeEngineComplianceBytes, decodeEngineCompliancePin } from "../engine-compliance.js";
import type { EngineCompliancePin } from "../engine-compliance.js";
export { decodeEngineCompliancePin, pinnedEngineCompliance } from "../engine-compliance.js";
export type { EngineCompliancePin } from "../engine-compliance.js";

async function manifestBytes(directory: string, pin: EngineCompliancePin, engineRelease: string, signal?: AbortSignal) {
  decodeEngineCompliancePin(pin, engineRelease);
  const bytes = await readBundleFile(directory, "compliance.json", pin.bytes, signal);
  if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw new VMError("PROTOCOL_ERROR", "engine compliance manifest integrity differs from its pin");
  return decodeEngineComplianceBytes(bytes, engineRelease);
}

export async function verifyEngineCompliance(directory: string, pin: EngineCompliancePin, engineRelease: string, signal?: AbortSignal) {
  const manifest = await manifestBytes(directory, pin, engineRelease, signal);
  for (const file of manifest.files) {
    const bytes = await readBundleFile(directory, file.name, file.bytes, signal);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new VMError("PROTOCOL_ERROR", `engine compliance integrity differs: ${file.name}`);
  }
  return manifest;
}

export async function resolveEngineCompliance(reference: EngineCompliancePin, engineRelease: string, options: { readonly directory?: string; readonly engineDirectory?: string; readonly cacheDir?: string; readonly signal?: AbortSignal } = {}): Promise<string> {
  const pin = decodeEngineCompliancePin(reference, engineRelease), { signal } = options;
  if (options.directory !== undefined) { const directory = resolve(options.directory); await verifyEngineCompliance(directory, pin, engineRelease, signal); return directory; }
  if (options.engineDirectory !== undefined) {
    const directory = join(options.engineDirectory, "compliance", pin.sha256);
    if (await lstat(directory).catch(() => undefined) !== undefined) { await verifyEngineCompliance(directory, pin, engineRelease, signal); return directory; }
  }
  const target = join(options.cacheDir ?? defaultEngineCacheDir(), "compliance", pin.sha256);
  if (await lstat(target).catch(() => undefined) !== undefined) { await verifyEngineCompliance(target, pin, engineRelease, signal); return target; }
  await atomicBundle(target, async staging => {
    await downloadArtifact(pin, join(staging, "compliance.json"), signal);
    const manifest = await manifestBytes(staging, pin, engineRelease, signal);
    for (const file of manifest.files) await downloadArtifact({ url: new URL(file.name, pin.url).href, bytes: file.bytes, sha256: file.sha256 }, join(staging, file.name), signal);
    await verifyEngineCompliance(staging, pin, engineRelease, signal);
  }, signal);
  return target;
}

export async function copyEngineCompliance(source: string, target: string, pin: EngineCompliancePin, engineRelease: string, signal?: AbortSignal): Promise<number> {
  const manifest = await verifyEngineCompliance(source, pin, engineRelease, signal);
  await atomicBundle(target, async staging => {
    for (const name of ["compliance.json", ...manifest.files.map(file => file.name)]) { await mkdir(dirname(join(staging, name)), { recursive: true }); await copyFile(join(source, name), join(staging, name)); await chmod(join(staging, name), 0o644); }
    await verifyEngineCompliance(staging, pin, engineRelease, signal);
  }, signal);
  return manifest.files.length + 1;
}
