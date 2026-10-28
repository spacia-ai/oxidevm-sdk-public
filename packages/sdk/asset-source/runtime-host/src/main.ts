import { engineReleaseId } from "../../../src/engine.generated.js";
import { serveFrame } from "../../../src/frame/host/server.js";
import { FRAME_PROTOCOL_VERSION, decodeFrameConnect, frameReady, isAcceptableEmbedder } from "../../../src/frame/protocol/handshake.js";
import { decodeFrameOptions } from "../../../src/frame/protocol/options.js";
import { createLocalVM } from "../../../src/local-vm.js";
import { eraseLocalData } from "../../../src/runtime/local-data.js";
import { VMError, serializeUnknownError } from "../../../src/runtime/errors.js";
import { sdkVersion } from "../../../src/sdk-version.js";
import { bootPing, sendBootPing } from "./telemetry.js";

/** Set at build time: the frame origin's /__t/v1/boot by default, empty for a frame that sends none. */
declare const OXIDEVM_TELEMETRY_ENDPOINT: string;

// The runtime frame (ADR 0021). It announces itself to the page that embeds it, accepts one port
// from that page, and runs the SDK's local VM for it with this release's engine, served next to
// this page as /engine/<release-id>/. Nothing else happens here: the page decides everything else.

const engineBaseUrl = new URL(`../../engine/${engineReleaseId}/`, location.href).href;
let connected = false;

function reject(port: MessagePort, error: VMError): void {
  port.postMessage({ v: FRAME_PROTOCOL_VERSION, type: "rejected", error: serializeUnknownError(error) });
  port.close();
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || window.parent === window) return;
  let decoded;
  try { decoded = decodeFrameConnect(event.data, event.ports); } catch { return; }
  if (decoded === undefined) return;
  const { connect, port } = decoded;
  if (connected) { reject(port, new VMError("PROTOCOL_ERROR", "this runtime frame already serves a page")); return; }
  if (!isAcceptableEmbedder(event.origin, location.origin)) { reject(port, new VMError("PERMISSION_DENIED", "the runtime frame serves only https pages and local development pages")); return; }
  if (connect.protocol !== FRAME_PROTOCOL_VERSION) { reject(port, new VMError("FEATURE_NOT_AVAILABLE", "the runtime frame does not speak that protocol version", { reason: "browser-unsupported" })); return; }
  if (!crossOriginIsolated) { reject(port, new VMError("FEATURE_NOT_AVAILABLE", "the runtime frame is not cross-origin isolated: the page must be, and must frame it with allow=\"cross-origin-isolated\"", { reason: "browser-unsupported" })); return; }
  connected = true;
  port.postMessage({ v: FRAME_PROTOCOL_VERSION, type: "accepted", engineReleaseId });
  serveFrame(port, {
    embedderOrigin: event.origin,
    // The page's erasure reaches this origin's storage partition, which it cannot open itself.
    eraseLocalData: signal => eraseLocalData({ signal }),
    create: async (options, signal, onProgress, previewKeeperHost) => {
      const decoded = decodeFrameOptions(options, engineBaseUrl);
      const started = performance.now();
      const report = { embedderOrigin: event.origin, sdkVersion, engineReleaseId, mode: decoded.mode };
      try {
        const vm = await createLocalVM({ ...decoded, signal, onProgress }, engineBaseUrl, { previewKeeperHost, embedderOrigin: event.origin });
        sendBootPing(OXIDEVM_TELEMETRY_ENDPOINT, bootPing({ ...report, milliseconds: performance.now() - started, result: { vm } }));
        return vm;
      } catch (error) {
        sendBootPing(OXIDEVM_TELEMETRY_ENDPOINT, bootPing({ ...report, milliseconds: performance.now() - started, result: { error } }));
        throw error;
      }
    },
  });
});

// The shell works offline once cached. A browser that refuses Service Workers in third-party frames
// (some privacy modes) still runs the frame online.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("./sw.js", location.href), { scope: "./" }).catch(() => undefined);
}

if (window.parent === window) {
  document.body.textContent = "This page runs OxideVM inside other pages; open the page that embeds it instead.";
} else {
  window.parent.postMessage(frameReady(), "*");
}
