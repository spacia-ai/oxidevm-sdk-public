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
  /**
   * A module the release loads only when something needs it (`LAZY_ENGINE_ARTIFACTS`): fetched and verified against its
   * pin on the first call, once for the VM.
   */
  lazy(name: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  dispose(): void;
}

/**
 * Engine modules a VM fetches only on first use, not at boot: the TLS module (engine ADR 0029), which only a WebAssembly
 * module with a network reach starts with.
 */
export const LAZY_ENGINE_ARTIFACTS: ReadonlySet<string> = new Set(["oxidevm_tls.wasm"]);
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
    if (artifact.mode !== mode || LAZY_ENGINE_ARTIFACTS.has(artifact.name)) continue;
    try { verified.push({ name: artifact.name, bytes: await fetchPinnedBytes(new URL(artifact.name, base), artifact.sha256, "engine", signal, progress, artifact.bytes) }); }
    catch (error: unknown) {
      if (!(error instanceof VMError) || error.code === "ABORTED") throw error;
      throw new VMError(error.code, `${error.message}: ${artifact.name} of engine release ${engineReleaseId}`, { ...error.detail, asset: artifact.name, engineRelease: engineReleaseId });
    }
  }
  const urls = new Map(verified.map(({ name, bytes }) => [name, URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }))]));
  const compiled = new Map<string, Promise<WebAssembly.Module>>(), lazy = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  const fetchLazy = (name: string, signal: AbortSignal | undefined): Promise<Uint8Array<ArrayBuffer>> => {
    const artifact = engineRelease.artifacts.find(entry => entry.name === name && entry.mode === mode);
    if (artifact === undefined || !LAZY_ENGINE_ARTIFACTS.has(name)) return Promise.reject(new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`));
    let loading = lazy.get(name);
    if (loading === undefined) {
      loading = fetchPinnedBytes(new URL(artifact.name, base), artifact.sha256, "engine", signal, undefined, artifact.bytes);
      lazy.set(name, loading);
      // A failed or cancelled load is tried again by the next caller.
      loading.catch(() => { if (lazy.get(name) === loading) lazy.delete(name); });
    }
    return loading;
  };
  return { urls, lazy: fetchLazy, compile: name => {
    let module = compiled.get(name);
    if (module === undefined) {
      const source = verified.find(artifact => artifact.name === name);
      if (source === undefined) throw new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`);
      module = WebAssembly.compile(source.bytes); compiled.set(name, module);
    }
    return module;
  }, dispose: () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); compiled.clear(); lazy.clear(); verified.length = 0; } };
}

export function requireEngineUrl(assets: LoadedEngineAssets, name: string): string {
  const url = assets.urls.get(name);
  if (url === undefined) throw new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`);
  return url;
}
