import { VMError } from "./errors.js";

/**
 * How the frame is isolated. `separate-origin` (ADR 0012, native execution) loads a document of another origin with
 * `allow-same-origin`, so it keeps that origin. `opaque` (ADR 0028, the module frame) loads a document of the opener's own
 * origin into `sandbox="allow-scripts"` only: the sandbox gives it an opaque origin, so it reaches none of the opener's
 * storage, and the bootstrap is posted to any origin, the only target an opaque document has.
 */
export type ExecutionFrameIsolation = "separate-origin" | "opaque";
/** How long a frame may take to load and answer its bootstrap. */
export const EXECUTION_BOOTSTRAP_MS = 10_000;

/** Shared ADR 0012 bootstrap: one isolated document and one origin-bound, one-use port. */
export async function openExecutionFrame<Result>(url: URL, bootstrap: (port: MessagePort, nonce: string) => object, decode: (input: unknown, nonce: string) => Result, signal?: AbortSignal, isolation: ExecutionFrameIsolation = "separate-origin"): Promise<{ readonly frame: HTMLIFrameElement; readonly port: MessagePort; readonly receipt: Result; dispose(): void }> {
  if (isolation === "separate-origin" && url.origin === location.origin) throw new VMError("INVALID_ARGUMENT", "JavaScript execution requires a separate origin");
  if (isolation === "opaque" && url.origin !== location.origin) throw new VMError("INVALID_ARGUMENT", "An opaque execution frame is served from its opener's own origin");
  const frame = document.createElement("iframe"), channel = new MessageChannel(), nonce = crypto.randomUUID(), ready = Promise.withResolvers<Result>();
  let sent = false, disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; channel.port1.close(); channel.port2.close(); frame.remove(); };
  frame.hidden = true; frame.allow = "cross-origin-isolated";
  if (isolation === "opaque") frame.sandbox.add("allow-scripts"); else frame.sandbox.add("allow-scripts", "allow-same-origin");
  frame.src = url.href;
  frame.onload = () => {
    if (sent || disposed || frame.contentWindow === null) return;
    sent = true; frame.contentWindow.postMessage(bootstrap(channel.port2, nonce), isolation === "opaque" ? "*" : url.origin, [channel.port2]);
  };
  frame.onerror = () => ready.reject(new VMError("CORE_LOAD_FAILED", "Execution document failed to load"));
  channel.port1.onmessageerror = () => ready.reject(new VMError("PROTOCOL_ERROR", "Execution bootstrap message failed"));
  channel.port1.onmessage = (event: MessageEvent<unknown>) => { try { if (!sent) throw new VMError("PROTOCOL_ERROR", "Execution bootstrap preceded admission"); ready.resolve(decode(event.data, nonce)); } catch (error) { ready.reject(error); } };
  channel.port1.start();
  const abort = () => ready.reject(new VMError("ABORTED", "Execution startup was aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ready.reject(new VMError("CORE_LOAD_FAILED", "Execution bootstrap exceeded ten seconds")), EXECUTION_BOOTSTRAP_MS);
  try {
    if (signal?.aborted === true) abort(); else document.body.append(frame);
    const receipt = await ready.promise; channel.port1.onmessage = null; channel.port1.onmessageerror = null;
    return { frame, port: channel.port1, receipt, dispose };
  } catch (error) { dispose(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); frame.onload = null; frame.onerror = null; }
}
