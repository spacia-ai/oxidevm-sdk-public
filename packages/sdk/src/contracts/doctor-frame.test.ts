import { expect, it } from "vitest";
import { decodeFrameMountProbe, decodeFramePageProbe } from "./doctor-frame.js";

function code(work: () => unknown): unknown {
  try { work(); } catch (error: unknown) { return typeof error === "object" && error !== null && "code" in error ? error.code : error; }
  throw new Error("expected a failure");
}

it("decodes what the frame probe saw in the application page", () => {
  const page = { secureContext: true, crossOriginIsolated: false, missingFeatures: ["wasm-tail-calls"] };
  expect(decodeFramePageProbe(page)).toEqual(page);
  for (const refused of [
    { ...page, extra: 1 }, { ...page, secureContext: "yes" }, { ...page, missingFeatures: "wasm-simd" },
    { ...page, missingFeatures: ["Wasm SIMD"] }, { ...page, missingFeatures: ["\u001b[2J"] }, { ...page, missingFeatures: new Array<string>(17).fill("wasm-simd") },
  ]) expect(code(() => decodeFramePageProbe(refused))).toBe("PROTOCOL_ERROR");
});

it("decodes whether the runtime frame accepted the page or what kept it out", () => {
  const accepted = { kind: "accepted", engineReleaseId: "a".repeat(64) };
  const blocked = { kind: "failed", code: "ABORTED", message: "VM creation was aborted", blockedBy: "frame-src" };
  const rejected = { kind: "failed", code: "FEATURE_NOT_AVAILABLE", message: "the runtime frame is not cross-origin isolated", blockedBy: null };
  for (const value of [accepted, blocked, rejected]) expect(decodeFrameMountProbe(value)).toEqual(value);
  for (const refused of [
    { ...accepted, engineReleaseId: "A".repeat(64) }, { ...accepted, extra: 1 }, { kind: "connected" },
    { ...blocked, code: "aborted" }, { ...blocked, message: "" }, { ...blocked, message: "line\u0007bell" }, { ...blocked, blockedBy: "frame src" }, { kind: "failed", code: "ABORTED", message: "x" },
  ]) expect(code(() => decodeFrameMountProbe(refused))).toBe("PROTOCOL_ERROR");
});
