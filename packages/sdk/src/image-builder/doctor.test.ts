import { expect, it } from "vitest";
import { decodeDoctorReport } from "../contracts/doctor.js";
import { doctorProject } from "./doctor.js";

it("requires every actual deployment check and rejects contradictory or omitted checks", () => {
  const checks = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => ({ check, status: "passed" }));
  const complete = { result: "passed", url: "http://localhost:5173/", checks: [...checks, { check: "preview-origin", status: "not-configured" }] };
  expect(decodeDoctorReport(complete).result).toBe("passed");
  expect(() => decodeDoctorReport({ ...complete, checks })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, result: "failed" })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, checks: [...checks, { check: "storage", status: "passed" }] })).toThrow();
});

it.each(["http://preview.localhost:4278", "http://0123456789abcdef.preview.localhost:4278", "http://[::1]:4278"])("admits secure localhost preview origins %s before cancellation", async previewOrigin => {
  await expect(doctorProject("http://localhost:4173/", { browser: "chromium", previewOrigin, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
});

it("rejects a remote insecure preview origin before launching any browser", async () => {
  await expect(doctorProject("http://localhost:4173/", { browser: "chromium", previewOrigin: "http://preview.example.com", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
