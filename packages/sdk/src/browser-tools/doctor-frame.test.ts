import { describe, expect, it } from "vitest";
import { engineRelease, engineReleaseId } from "../engine.generated.js";
import { sdkVersion } from "../sdk-version.js";
import { frameChecks } from "./doctor-frame.js";
import type { EngineFile, FrameObservation } from "./doctor-frame.js";

const ORIGIN = "https://run.example.net";
const FRAME = `${ORIGIN}/v/${encodeURIComponent(sdkVersion)}/`, ENGINE = `${ORIGIN}/engine/${engineReleaseId}/`;
const intact: EngineFile = { served: true, intact: true, wasm: true };
const healthy: FrameObservation = {
  frameOrigin: ORIGIN, page: { secureContext: true, crossOriginIsolated: true, missingFeatures: [] },
  frame: { kind: "mounted", mount: { kind: "accepted", engineReleaseId } }, engine: engineRelease.artifacts.map(() => intact),
};
const status = (observed: FrameObservation) => frameChecks(observed).map(check => check.status === "failed" ? `${check.check}: ${check.message}` : `${check.check}: ${check.status}`);

describe("frame-hosted doctor checks", () => {
  it("passes what the application owns and leaves workers and storage to the runtime frame", () => {
    expect(status(healthy)).toEqual([
      "secure-context: passed", "cross-origin-isolation: passed", "wasm-features: passed", "worker-load: not-applicable",
      "asset-integrity: passed", "wasm-mime: passed", "content-security-policy: passed", "storage: not-applicable",
    ]);
  });

  it("names a runtime frame that is not served for this SDK release", () => {
    expect(status({ ...healthy, frame: { kind: "not-served", cause: "HTTP 404" }, engine: healthy.engine.map(() => ({ served: false, cause: "HTTP 404" })) })).toEqual([
      "secure-context: passed", "cross-origin-isolation: passed", "wasm-features: passed", "worker-load: not-applicable",
      `asset-integrity: the runtime frame for this SDK release is not served at ${FRAME} (HTTP 404)`,
      `wasm-mime: the runtime frame does not serve this SDK release's engine at ${ENGINE} (HTTP 404)`,
      `content-security-policy: the runtime frame is not served at ${FRAME}, so the application's Content-Security-Policy was not checked against it`,
      "storage: not-applicable",
    ]);
  });

  it("blames the application's Content-Security-Policy when it keeps the frame out", () => {
    const checks = status({ ...healthy, frame: { kind: "mounted", mount: { kind: "failed", code: "ABORTED", message: "VM creation was aborted", blockedBy: "frame-src" } } });
    expect(checks).toContain(`content-security-policy: the application's Content-Security-Policy (frame-src) blocks the runtime frame ${ORIGIN}`);
    expect(checks).toContain(`asset-integrity: the runtime frame at ${FRAME} did not load: the application's Content-Security-Policy (frame-src) blocks it`);
  });

  it("reports the frame's own reason when it does not accept the page", () => {
    const checks = status({ ...healthy, frame: { kind: "mounted", mount: { kind: "failed", code: "FEATURE_NOT_AVAILABLE", message: "the runtime frame is not cross-origin isolated", blockedBy: null } } });
    expect(checks).toContain(`asset-integrity: the runtime frame at ${FRAME} did not accept the application page: the runtime frame is not cross-origin isolated`);
    expect(checks).toContain("content-security-policy: passed");
  });

  it("refuses a frame on another engine release or with altered engine files, and engine files without the Wasm MIME type", () => {
    const other = "b".repeat(64);
    expect(status({ ...healthy, frame: { kind: "mounted", mount: { kind: "accepted", engineReleaseId: other } } })).toContain(`asset-integrity: the runtime frame at ${FRAME} runs engine release ${other}, not this SDK release's ${engineReleaseId}`);
    const altered = status({ ...healthy, engine: [{ ...intact, intact: false }, ...healthy.engine.slice(1)] });
    expect(altered).toContain(`asset-integrity: the runtime frame's engine files at ${ENGINE} differ from this SDK release's pins`);
    expect(altered).toContain("wasm-mime: passed");
    const untyped = status({ ...healthy, engine: [...healthy.engine.slice(1), { ...intact, wasm: false }] });
    expect(untyped).toContain(`wasm-mime: the runtime frame serves its engine at ${ENGINE} without Content-Type application/wasm`);
    expect(untyped).toContain("asset-integrity: passed");
  });

  it("reports an insecure, non-isolated page and a browser that lacks required features", () => {
    expect(status({ ...healthy, page: { secureContext: false, crossOriginIsolated: false, missingFeatures: ["wasm-simd", "wasm-tail-calls"] } }).slice(0, 3)).toEqual([
      "secure-context: the application page is not a secure context; serve it over HTTPS or from localhost",
      "cross-origin-isolation: the application page is not cross-origin isolated; serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp or credentialless",
      "wasm-features: this browser lacks features OxideVM requires: wasm-simd, wasm-tail-calls",
    ]);
  });
});
