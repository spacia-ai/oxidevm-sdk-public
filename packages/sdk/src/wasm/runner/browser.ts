import type { LinuxParts } from "./host.js";
import type { BrowserProbe } from "./prerequisites.js";
import type { RunnerContext } from "./run.js";

/** The parts of a worker's global scope the probe reads, so tests can offer a fake scope. */
export interface BrowserScope {
  readonly crossOriginIsolated: boolean;
  readonly indexedDB?: unknown;
  readonly navigator?: object;
  readonly WebAssembly: object;
}

/** What this worker offers. JSPI needs both halves of the API: `promising` and `Suspending`. */
export function probeBrowser(scope: BrowserScope): BrowserProbe {
  return {
    crossOriginIsolated: scope.crossOriginIsolated,
    indexedDB: scope.indexedDB !== undefined,
    jspi: typeof Reflect.get(scope.WebAssembly, "promising") === "function" && typeof Reflect.get(scope.WebAssembly, "Suspending") === "function",
    webLocks: scope.navigator !== undefined && "locks" in scope.navigator,
  };
}

/** Evaluates a verified adapter bundle as an ES module through a short-lived blob URL. */
export async function importAdapterFromBlob(bytes: Uint8Array<ArrayBuffer>): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    const namespace: unknown = await import(/* @vite-ignore */ url);
    return namespace;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Binds the runner to this worker's `fetch`, `navigator.locks` and dynamic `import`. */
export function browserContext(linux: LinuxParts): RunnerContext {
  return {
    ...linux,
    fetch: (url, init) => fetch(url, { signal: init.signal }),
    locks: "locks" in navigator ? navigator.locks : undefined,
    browser: probeBrowser(globalThis),
    importAdapter: importAdapterFromBlob,
  };
}
