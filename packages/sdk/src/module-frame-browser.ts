import { VMError } from "./runtime/errors.js";
import { MODULE_FRAME_HEARTBEAT_MS, MODULE_FRAME_MISSED_BEATS, type ModuleFrameHandle, type ModuleFrameOpener, type ModuleFrameSources } from "./module-execution.js";
import { openModuleFrame, type OpenModuleFrame } from "./runtime/module-frame.js";

// The document side of a VM's module frame (engine ADR 0028): where the frame and its code live among the SDK's own
// assets, and how a frame on the page is watched. Only a page or the hosted runtime frame's document runs this; the
// owner (`module-execution.ts`) stays free of the DOM.

/**
 * Where a deployment serves the module frame: `module-frame/` beside the runtime's engine assets (`baseUrl`), on the
 * opener's own origin (the application's when self-hosted, `/v/<sdk>/` of the runtime frame when hosted). The directory
 * holds the frame document, the broker and the runner, and is served with the frame's own headers (`frame.json`).
 */
export function moduleFrameBase(baseUrl: string): URL { return new URL("module-frame/", new URL(baseUrl, location.href)); }
const SOURCE_TIMEOUT_MS = 30_000;

async function readAsset(url: URL, signal: AbortSignal | undefined): Promise<Blob> {
  const timeout = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  let response: Response;
  try { response = await fetch(url, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), credentials: "same-origin" }); }
  catch (error: unknown) {
    if (signal?.aborted === true) throw new VMError("ABORTED", "Opening the module frame was cancelled");
    throw new VMError("CORE_LOAD_FAILED", `The SDK asset ${url.pathname} could not be fetched`, { reason: "module-frame-asset", cause: error instanceof Error ? error.name : "unknown" });
  }
  if (!response.ok) throw new VMError("CORE_LOAD_FAILED", `The SDK asset ${url.pathname} is unavailable (HTTP ${String(response.status)})`, { reason: "module-frame-asset" });
  return new Blob([await response.arrayBuffer()], { type: "text/javascript" });
}

/** The broker and runner code from the deployment's module frame directory: the opener's origin, never the frame's. */
async function readModuleFrameSources(base: URL, signal: AbortSignal | undefined): Promise<ModuleFrameSources> {
  const [broker, runner] = await Promise.all([readAsset(new URL("broker.js", base), signal), readAsset(new URL("runner.js", base), signal)]);
  return { broker, runner };
}

/**
 * Watches a frame on the page: it is lost when it leaves the document, or when its broker misses
 * MODULE_FRAME_MISSED_BEATS heartbeats in a row (a crashed frame process stays in the DOM, and a broker that dies of
 * memory exhaustion leaves its document running). Chromium may keep the
 * frame's workers for about half a second after removal; the Userspace worker ends their processes anyway.
 */
function watchModuleFrame(frame: OpenModuleFrame, lost: () => void): () => void {
  let missed = 0, ended = false;
  const end = (): void => { if (ended) return; ended = true; observer.disconnect(); clearInterval(timer); frame.liveness.onmessage = null; };
  const fire = (): void => { if (ended) return; end(); lost(); };
  const observer = new MutationObserver(() => { if (!frame.frame.isConnected) fire(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  frame.liveness.onmessage = () => { missed = 0; };
  frame.liveness.start();
  const timer = setInterval(() => {
    if (++missed > MODULE_FRAME_MISSED_BEATS) fire(); else frame.liveness.postMessage("ping");
  }, MODULE_FRAME_HEARTBEAT_MS);
  return end;
}

/** Opens and watches module frames from this document, from the deployment's module frame directory under `baseUrl`. */
export function browserModuleFrames(baseUrl: string): ModuleFrameOpener {
  const frames = new WeakMap<ModuleFrameHandle, OpenModuleFrame>(), base = moduleFrameBase(baseUrl);
  return {
    open: async (sources, signal) => {
      const opened = await openModuleFrame(new URL("index.html", base), sources, signal);
      const handle: ModuleFrameHandle = { port: opened.port, dispose: () => { opened.dispose(); } };
      frames.set(handle, opened);
      return handle;
    },
    sources: signal => readModuleFrameSources(base, signal),
    watch: (handle, lost) => {
      const opened = frames.get(handle);
      if (opened === undefined) throw new VMError("PROTOCOL_ERROR", "The module frame was not opened here");
      return watchModuleFrame(opened, lost);
    },
  };
}
