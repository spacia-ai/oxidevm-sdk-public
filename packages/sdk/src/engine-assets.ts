import type { BootProgress } from "./contracts.js";
import type { RuntimeMode } from "./values.js";
import { engineRelease, engineReleaseId } from "./engine.generated.js";
import { VMError } from "./runtime/errors.js";
import { abortIfRequested, fetchPinnedBytes } from "./pinned-assets.js";
import { pinnedEngineCompliance } from "./engine-compliance.js";
import { retainEngineCompliance } from "./engine-assets-compliance.js";
export { abortIfRequested, fetchPinnedBytes } from "./pinned-assets.js";

export interface LoadedEngineAssets {
  readonly urls: ReadonlyMap<string, string>;
  compile(name: string): Promise<WebAssembly.Module>;
  dispose(): void;
}
/**
 * Fetches the pinned engine release's modules for `mode` from `base` (the application's
 * `runtime.baseUrl`). Every module is verified against its pinned size and SHA-256 before any
 * Blob URL exists, so a failed load leaves nothing a worker could execute.
 */
export async function loadEngineAssets(mode: RuntimeMode, base: string, signal?: AbortSignal, progress?: (progress: BootProgress) => void): Promise<LoadedEngineAssets> {
  abortIfRequested(signal);
  await retainEngineCompliance(base, pinnedEngineCompliance(), engineReleaseId, signal, progress);
  const verified: { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (const artifact of engineRelease.artifacts) {
    if (artifact.mode !== mode) continue;
    try { verified.push({ name: artifact.name, bytes: await fetchPinnedBytes(new URL(artifact.name, base), artifact.sha256, "engine", signal, progress, artifact.bytes) }); }
    catch (error: unknown) {
      if (!(error instanceof VMError) || error.code === "ABORTED") throw error;
      throw new VMError(error.code, `${error.message}: ${artifact.name} of engine release ${engineReleaseId}`, { ...error.detail, asset: artifact.name, engineRelease: engineReleaseId });
    }
  }
  const urls = new Map(verified.map(({ name, bytes }) => [name, URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }))]));
  const compiled = new Map<string, Promise<WebAssembly.Module>>();
  return { urls, compile: name => {
    let module = compiled.get(name);
    if (module === undefined) {
      const source = verified.find(artifact => artifact.name === name);
      if (source === undefined) throw new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`);
      module = WebAssembly.compile(source.bytes); compiled.set(name, module);
    }
    return module;
  }, dispose: () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); compiled.clear(); verified.length = 0; } };
}

export function requireEngineUrl(assets: LoadedEngineAssets, name: string): string {
  const url = assets.urls.get(name);
  if (url === undefined) throw new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`);
  return url;
}
