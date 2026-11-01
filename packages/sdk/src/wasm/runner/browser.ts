import type { LinuxClient } from "../../runtime/js-process/transport.js";
import { dispositionOperation } from "../../runtime/js-process/signals.js";
import type { LinuxParts } from "./host.js";
import type { BrowserProbe } from "./prerequisites.js";
import type { RunnerContext } from "./run.js";
import type { SignalTransport } from "./signals.js";

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

/** Evaluates a verified adapter bundle as an ES module through a short-lived blob URL; a module script needs a JavaScript type. */
export async function importAdapterFromBlob(bundle: Blob): Promise<unknown> {
  const url = URL.createObjectURL(bundle.type === "text/javascript" ? bundle : new Blob([bundle], { type: "text/javascript" }));
  try {
    const namespace: unknown = await import(/* @vite-ignore */ url);
    return namespace;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The process's signal words and OXJR 65550, through its Linux client (JS process protocol 4, engine ADR 0027). */
export function clientSignals(client: LinuxClient): SignalTransport {
  return {
    setDisposition: (signal, disposition) => client.call(dispositionOperation(signal, disposition)),
    listen: listener => { client.listenForSignals(listener); },
    get interruptWord() { return client.interruptWord; },
    signaled: signal => { client.signaled(signal); },
  };
}

/** Binds the runner to this worker's `fetch`, `navigator.locks`, dynamic `import` and its process's signals. */
export function browserContext(linux: LinuxParts, client: LinuxClient): RunnerContext {
  return {
    ...linux,
    fetch: (url, init) => fetch(url, { signal: init.signal }),
    locks: "locks" in navigator ? navigator.locks : undefined,
    browser: probeBrowser(globalThis),
    importAdapter: importAdapterFromBlob,
    signals: clientSignals(client),
  };
}
