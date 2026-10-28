import { VMError } from "./errors.js";

/** Shared ADR 0012 bootstrap: one isolated document and one origin-bound, one-use port. */
export async function openExecutionFrame<Result>(url: URL, bootstrap: (port: MessagePort, nonce: string) => object, decode: (input: unknown, nonce: string) => Result, signal?: AbortSignal): Promise<{ readonly frame: HTMLIFrameElement; readonly port: MessagePort; readonly receipt: Result; dispose(): void }> {
  if (url.origin === location.origin) throw new VMError("INVALID_ARGUMENT", "JavaScript execution requires a separate origin");
  const frame = document.createElement("iframe"), channel = new MessageChannel(), nonce = crypto.randomUUID(), ready = Promise.withResolvers<Result>();
  let sent = false, disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; channel.port1.close(); channel.port2.close(); frame.remove(); };
  frame.hidden = true; frame.allow = "cross-origin-isolated"; frame.sandbox.add("allow-scripts", "allow-same-origin"); frame.src = url.href;
  frame.onload = () => {
    if (sent || disposed || frame.contentWindow === null) return;
    sent = true; frame.contentWindow.postMessage(bootstrap(channel.port2, nonce), url.origin, [channel.port2]);
  };
  frame.onerror = () => ready.reject(new VMError("CORE_LOAD_FAILED", "Execution document failed to load"));
  channel.port1.onmessageerror = () => ready.reject(new VMError("PROTOCOL_ERROR", "Execution bootstrap message failed"));
  channel.port1.onmessage = (event: MessageEvent<unknown>) => { try { if (!sent) throw new VMError("PROTOCOL_ERROR", "Execution bootstrap preceded admission"); ready.resolve(decode(event.data, nonce)); } catch (error) { ready.reject(error); } };
  channel.port1.start();
  const abort = () => ready.reject(new VMError("ABORTED", "Execution startup was aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ready.reject(new VMError("CORE_LOAD_FAILED", "Execution bootstrap exceeded ten seconds")), 10_000);
  try {
    if (signal?.aborted === true) abort(); else document.body.append(frame);
    const receipt = await ready.promise; channel.port1.onmessage = null; channel.port1.onmessageerror = null;
    return { frame, port: channel.port1, receipt, dispose };
  } catch (error) { dispose(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); frame.onload = null; frame.onerror = null; }
}
