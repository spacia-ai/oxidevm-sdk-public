import { VMError } from "../../runtime/errors.js";
import { sdkVersion } from "../../sdk-version.js";
import { connectRejection, decodeFrameConnectReply, decodeFrameReady, frameConnect, negotiateFrameProtocol } from "../protocol/handshake.js";

/** How long the page waits for the frame to load and answer before it gives up. */
export const FRAME_CONNECT_TIMEOUT_MS = 30_000;

export interface MountedRuntimeFrame {
  readonly port: MessagePort;
  readonly engineReleaseId: string;
  /** Removes the frame; its runtime and storage handles go with it. */
  remove(): void;
}

/** The address of this SDK release's runtime frame on `origin`. */
export function runtimeFrameUrl(origin: string): string {
  return new URL(`/v/${encodeURIComponent(sdkVersion)}/`, origin).href;
}

/**
 * Inserts the hidden runtime frame, waits for it to announce itself, and connects a port to it.
 * Only a message from that frame's window and origin is accepted, and the port goes to that
 * origin only.
 */
export async function mountRuntimeFrame(origin: string, signal?: AbortSignal): Promise<MountedRuntimeFrame> {
  const iframe = document.createElement("iframe");
  iframe.src = runtimeFrameUrl(origin);
  // Delegate personal relay access, including Chromium's legacy combined permission.
  iframe.allow = "cross-origin-isolated; local-network-access; loopback-network";
  iframe.title = "OxideVM runtime";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  const remove = () => iframe.remove();
  const connected = Promise.withResolvers<{ readonly port: MessagePort; readonly engineReleaseId: string }>();
  const fail = (error: Error) => connected.reject(error);
  const timeout = setTimeout(() => fail(new VMError("FEATURE_NOT_AVAILABLE", `the OxideVM runtime frame at ${origin} did not answer within ${String(FRAME_CONNECT_TIMEOUT_MS / 1000)} s; check that the page may frame it (Content-Security-Policy frame-src) and is cross-origin isolated`, { reason: "browser-unsupported" })), FRAME_CONNECT_TIMEOUT_MS);
  const abort = () => fail(new VMError("ABORTED", "VM creation was aborted"));
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== origin) return;
    let ready;
    try { ready = decodeFrameReady(event.data); } catch (error: unknown) { fail(asError(error)); return; }
    if (ready === undefined) return;
    window.removeEventListener("message", onMessage);
    try { negotiateFrameProtocol(ready); } catch (error: unknown) { fail(asError(error)); return; }
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", (reply: MessageEvent) => {
      try {
        const decoded = decodeFrameConnectReply(reply.data);
        if (decoded.type === "rejected") { fail(connectRejection(decoded)); return; }
        connected.resolve({ port: channel.port1, engineReleaseId: decoded.engineReleaseId });
      } catch (error: unknown) { fail(asError(error)); }
    }, { once: true });
    channel.port1.start();
    iframe.contentWindow?.postMessage(frameConnect(sdkVersion), { targetOrigin: origin, transfer: [channel.port2] });
  };
  window.addEventListener("message", onMessage);
  signal?.addEventListener("abort", abort, { once: true });
  document.body.append(iframe);
  try {
    const { port, engineReleaseId } = await connected.promise;
    return { port, engineReleaseId, remove };
  } catch (error) {
    remove();
    throw error;
  } finally {
    clearTimeout(timeout);
    window.removeEventListener("message", onMessage);
    signal?.removeEventListener("abort", abort);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new VMError("PROTOCOL_ERROR", String(error));
}
