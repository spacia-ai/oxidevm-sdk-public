import type { LinuxProcessContext } from "../../js-process-types.js";
import type { ProcessId } from "../../values.js";
import { atFiles } from "../../runtime/js-process/at-operations.js";
import { clockHost, randomHost } from "../../runtime/js-process/clock-random.js";
import { processSync } from "../../runtime/js-process/process-sync.js";
import type { LinuxClient } from "../../runtime/js-process/transport.js";
import type { RunnerLaunch } from "../../runtime/js-process/launch.js";
import { processNetPorts } from "./net-ports.js";
import { dispositionOperation, maskOperation, pendingOperation } from "../../runtime/js-process/signals.js";
import { process } from "../../runtime/js-process/process.js";
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

/** The process's signal buffer and OXJR 65550, through its Linux client (JS process protocol 5, engine ADR 0027). */
export function clientSignals(client: LinuxClient): SignalTransport {
  const linux = process(client);
  let pid: Promise<ProcessId> | undefined;
  return {
    setDisposition: (signal, disposition) => client.call(dispositionOperation(signal, disposition)),
    listen: listener => { client.listenForSignals(listener); },
    get interruptWord() { return client.interruptWord; },
    mask: (how, set) => client.call(maskOperation(how, set)),
    pending: () => client.call(pendingOperation()),
    kill: async signal => {
      pid ??= linux.info().then(info => info.pid);
      await linux.signal(await pid, signal);
    },
  };
}

/**
 * Binds the runner to this worker's dynamic `import`, its process's signals, its process's synchronous Linux calls
 * (`host.at`, `host.clock`, `host.random`, `host.process.*Sync`) and its VM network (with the TLS module its start
 * carried); it fetches nothing and holds no lock.
 */
export function browserContext(linux: LinuxProcessContext, client: LinuxClient, launch: RunnerLaunch | undefined): RunnerContext {
  const local = globalThis.fetch.bind(globalThis);
  return {
    ...linux,
    filesAt: atFiles(client), clock: clockHost(client), random: randomHost(client), processSync: processSync(client),
    browser: probeBrowser(globalThis),
    importAdapter: importAdapterFromBlob,
    signals: clientSignals(client),
    network: { ports: processNetPorts(client, linux.files, linux.filesSync, launch?.tls?.module ?? null), scope: globalThis, local },
  };
}
