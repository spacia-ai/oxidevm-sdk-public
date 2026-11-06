import type { BootProgress } from "./contracts.js";
import type { RuntimeMode } from "./values.js";
import { engineRelease, engineReleaseId } from "./engine.generated.js";
import { VMError } from "./runtime/errors.js";
import { abortIfRequested, fetchPinnedBytes } from "./pinned-assets.js";
import { pinnedEngineCompliance } from "./engine-compliance.js";
import { retainEngineCompliance } from "./engine-assets-compliance.js";
import { engineLoad, inOrder } from "./engine-load.js";
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
 * Fetches the pinned engine release's modules for `mode` from `base` (the application's `runtime.baseUrl`), together
 * with its pinned compliance materials (`retainEngineCompliance`): every file downloads at once and is verified
 * against its pinned size and SHA-256 before any Blob URL exists, so a failed load leaves nothing a worker could
 * execute. A failure is reported in a fixed order, the compliance materials first and then the modules in release
 * order, and stops the downloads still running.
 */
export async function loadEngineAssets(mode: RuntimeMode, base: string, signal?: AbortSignal, progress?: (progress: BootProgress) => void): Promise<LoadedEngineAssets> {
  abortIfRequested(signal);
  const compliance = pinnedEngineCompliance(), load = engineLoad(signal, progress);
  // The compliance manifest goes first: it is small and names four more files, and a server may answer requests of one
  // priority in the order they arrive, so behind the modules it would wait for all of them.
  const retained = retainEngineCompliance(base, compliance, engineReleaseId, load);
  const modules = engineRelease.artifacts.filter(artifact => artifact.mode === mode && !LAZY_ENGINE_ARTIFACTS.has(artifact.name)).map(artifact =>
    load.fetch(new URL(artifact.name, base), artifact.sha256, artifact.bytes).then(bytes => ({ name: artifact.name, bytes }), (error: unknown) => { throw ofArtifact(error, artifact.name); }));
  load.seal();
  try { await inOrder<unknown>([retained, ...modules]); }
  catch (error: unknown) { await load.cancel(); throw error; }
  const verified = await Promise.all(modules);
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

/** A module's failure names the module and its engine release; a cancellation stays as it is. */
function ofArtifact(error: unknown, name: string): unknown {
  if (!(error instanceof VMError) || error.code === "ABORTED") return error;
  return new VMError(error.code, `${error.message}: ${name} of engine release ${engineReleaseId}`, { ...error.detail, asset: name, engineRelease: engineReleaseId });
}

export function requireEngineUrl(assets: LoadedEngineAssets, name: string): string {
  const url = assets.urls.get(name);
  if (url === undefined) throw new VMError("CORE_LOAD_FAILED", `SDK release does not contain ${name}`);
  return url;
}
