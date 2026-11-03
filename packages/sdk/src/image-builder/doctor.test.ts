import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeDoctorReport } from "../contracts/doctor.js";
import { legacyImageLocations } from "../default-images.test-support.js";
import { doctorLockCheck, doctorProject } from "./doctor.js";
import { createProjectLock, validateProjectLock } from "./project.js";

it("requires every actual deployment check and rejects contradictory or omitted checks", () => {
  const checks = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => ({ check, status: "passed" }));
  const complete = { result: "passed", url: "http://localhost:5173/", checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "passed" }] };
  expect(decodeDoctorReport(complete).result).toBe("passed");
  expect(decodeDoctorReport({ ...complete, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "not-configured" }] }).checks).toContainEqual({ check: "lock", status: "not-configured" });
  expect(() => decodeDoctorReport({ ...complete, checks })).toThrow();
  // The lock check is mandatory and closed: omitted, unknown or contradictory forms are refused.
  expect(() => decodeDoctorReport({ ...complete, checks: [...checks, { check: "preview-origin", status: "not-configured" }] })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "skipped" }] })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "failed", message: "stale" }] })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, result: "failed" })).toThrow();
  expect(() => decodeDoctorReport({ ...complete, checks: [...checks, { check: "storage", status: "passed" }] })).toThrow();
});

function failure(work: () => unknown): unknown {
  try { work(); } catch (error: unknown) { return error; }
  throw new Error("expected a failure");
}

it("checks the project lock against this SDK release with the same explanation as assets install", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-doctor-lock-"));
  try {
    expect(await doctorLockCheck(undefined)).toEqual({ check: "lock", status: "not-configured" });
    const config = { mode: "userspace" as const, image: { ...legacyImageLocations.userspace, manifestUrl: "/oxidevm/images/custom/manifest.json" } };
    const configPath = join(root, "oxidevm.config.json"), lockPath = join(root, "oxidevm.lock.json");
    await writeFile(configPath, JSON.stringify(config));
    expect(await doctorLockCheck(configPath)).toEqual({ check: "lock", status: "failed", message: "project lock oxidevm.lock.json is missing; run `npx oxidevm assets install` to write it" });
    const lock = createProjectLock(config);
    await writeFile(lockPath, JSON.stringify(lock));
    expect(await doctorLockCheck(configPath)).toEqual({ check: "lock", status: "passed" });
    const stale = { ...lock, sdkVersion: "0.0.8", cliVersion: "0.0.8", engineRelease: `sha256:${"e".repeat(64)}` };
    await writeFile(lockPath, JSON.stringify(stale));
    const explained = failure(() => validateProjectLock(stale, config));
    expect(await doctorLockCheck(configPath)).toEqual({ check: "lock", status: "failed", message: explained instanceof Error ? explained.message : "" });
    // `assets install --image` records its image only in the lock; the doctor compares the rest with this release.
    await writeFile(configPath, JSON.stringify({ mode: "userspace" }));
    await writeFile(lockPath, JSON.stringify(lock));
    expect(await doctorLockCheck(configPath)).toEqual({ check: "lock", status: "passed" });
    await writeFile(lockPath, "[]");
    expect(await doctorLockCheck(configPath)).toEqual({ check: "lock", status: "failed", message: "project lock must be an object" });
    expect(await doctorLockCheck(join(root, "absent.config.json"))).toMatchObject({ check: "lock", status: "failed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["http://preview.localhost:4278", "http://0123456789abcdef.preview.localhost:4278", "http://[::1]:4278"])("admits secure localhost preview origins %s before cancellation", async previewOrigin => {
  await expect(doctorProject("http://localhost:4173/", { browser: "chromium", previewOrigin, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
});

it("rejects a remote insecure preview origin before launching any browser", async () => {
  await expect(doctorProject("http://localhost:4173/", { browser: "chromium", previewOrigin: "http://preview.example.com", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
