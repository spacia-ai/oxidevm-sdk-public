import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeDoctorReport } from "../contracts/doctor.js";
import { legacyImageLocations } from "../default-images.test-support.js";
import { doctorLockCheck, doctorProject } from "./doctor.js";
import { createProjectLock, validateProjectLock } from "./project.js";

const SELF_HOSTED = { kind: "self-hosted", assets: "http://localhost:5173/oxidevm/" };
const FRAME = { kind: "frame", frame: "https://run.oxidevm.dev/v/0.0.15/" };

it("requires every actual deployment check and rejects contradictory or omitted checks", () => {
  const checks = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => ({ check, status: "passed" }));
  const complete = { result: "passed", url: "http://localhost:5173/", hosting: SELF_HOSTED, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "passed" }] };
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

it("names the runtime it checked and leaves only what runs inside the runtime frame to that frame", () => {
  const owned = new Set(["worker-load", "storage"]);
  const checks = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => owned.has(check) ? { check, status: "not-applicable" } : { check, status: "passed" });
  const frame = { result: "passed", url: "https://app.example/", hosting: FRAME, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "not-configured" }] };
  expect(decodeDoctorReport(frame)).toEqual(frame);
  expect(decodeDoctorReport({ ...frame, hosting: SELF_HOSTED, checks: frame.checks.map(check => owned.has(check.check) ? { check: check.check, status: "passed" } : check) }).hosting).toEqual(SELF_HOSTED);
  // A self-hosted application serves its own workers and storage, and no other check may go unchecked.
  for (const refused of [{ ...frame, hosting: SELF_HOSTED }, { ...frame, checks: frame.checks.map(check => check.check === "wasm-mime" ? { check: "wasm-mime", status: "not-applicable" } : check) }]) {
    expect(code(() => decodeDoctorReport(refused))).toBe("PROTOCOL_ERROR");
  }
  const unnamed = { result: frame.result, url: frame.url, checks: frame.checks };
  for (const hosting of [undefined, { kind: "cdn", frame: FRAME.frame }, { kind: "frame" }, { kind: "frame", frame: FRAME.frame, extra: 1 }, { kind: "frame", frame: "ftp://run.example/v/1/" }, { kind: "self-hosted", assets: "https://user:secret@app.example/oxidevm/" }, { kind: "self-hosted", assets: "not a URL" }]) {
    expect(code(() => decodeDoctorReport(hosting === undefined ? unnamed : { ...frame, hosting }))).toBe("PROTOCOL_ERROR");
  }
});

function code(work: () => unknown): unknown {
  const error = failure(work);
  return typeof error === "object" && error !== null && "code" in error ? error.code : error;
}

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

it.each([undefined, "frame" as const])("admits a secure or localhost runtime frame origin with hosting %s before cancellation", async hosting => {
  for (const frameOrigin of ["https://run.example.net", "http://run.localhost:4179"]) {
    await expect(doctorProject("http://localhost:4173/", { browser: "chromium", ...(hosting === undefined ? {} : { hosting }), frameOrigin, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
  }
});

it("rejects an unknown hosting and a frame origin that is not a secure origin, before launching any browser", async () => {
  const signal = AbortSignal.abort();
  const refused: readonly unknown[] = [
    { hosting: "cdn" }, { hosting: "self-hosted", frameOrigin: "https://run.example.net" },
    { frameOrigin: "http://run.example.net" }, { frameOrigin: "https://run.example.net/v/0.0.15/" }, { frameOrigin: "run.example.net" },
  ];
  for (const options of refused) {
    await expect(doctorProject("http://localhost:4173/", { browser: "chromium", signal, ...(typeof options === "object" && options !== null ? options : {}) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
});
