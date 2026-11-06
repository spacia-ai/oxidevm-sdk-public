import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeDoctorReport } from "../contracts/doctor.js";
import type { DoctorReport } from "../contracts/doctor.js";
import { VMError } from "../runtime/errors.js";
import { decodeBundleJSON, localBundlePath } from "./bundle-files.js";
import { hashFile } from "./files.js";
import { getSDKRelease, loadProjectConfig, lockedImage, validateProjectLock } from "./project.js";
import { readProjectLockFile } from "./project-lock-file.js";
import { abortIfRequested } from "./tools.js";
import { isTrustworthyURL } from "../trustworthy-url.js";

export interface DoctorOptions {
  readonly browser: "chromium" | "firefox" | "webkit";
  /**
   * The runtime the application uses (engine ADR 0021): `self-hosted` checks its own runtime assets, `frame` its page and
   * the hosted runtime frame of this SDK release. Without it the doctor checks a self-hosted runtime when the
   * application serves the SDK's doctor probe at its asset base, and the hosted frame otherwise; the report names which.
   */
  readonly hosting?: "frame" | "self-hosted";
  /** The runtime frame's origin when the frame is checked; `https://run.oxidevm.dev` by default. */
  readonly frameOrigin?: string;
  readonly previewOrigin?: string;
  /** The project configuration whose `oxidevm.lock.json` the `lock` check compares with this SDK; without it that check is `not-configured`. */
  readonly project?: string;
  readonly signal?: AbortSignal;
}
interface DoctorRunner { runDoctorBrowser(url: string, options: DoctorOptions, profile: string, assets: readonly { readonly relative: string; readonly sha256: string }[], engineRelease: string): Promise<unknown> }
function isRunner(value: unknown): value is DoctorRunner { return typeof value === "object" && value !== null && "runDoctorBrowser" in value && typeof value.runDoctorBrowser === "function"; }

type DoctorCheckResult = DoctorReport["checks"][number];

/** The closed `lock` check: the project's lock against this SDK release, explained as `assets install` explains it. */
export async function doctorLockCheck(project: string | undefined, signal?: AbortSignal): Promise<DoctorCheckResult> {
  if (project === undefined) return { check: "lock", status: "not-configured" };
  try {
    const loaded = await loadProjectConfig(project);
    const bytes = await readProjectLockFile(loaded.directory, signal);
    if (bytes === undefined) return { check: "lock", status: "failed", message: "project lock oxidevm.lock.json is missing; run `npx oxidevm assets install` to write it" };
    const value = decodeBundleJSON(bytes);
    // `assets install --image` records an image the configuration does not name only in the lock.
    validateProjectLock(value, loaded.config.image === undefined ? { ...loaded.config, image: lockedImage(value) } : loaded.config);
    return { check: "lock", status: "passed" };
  } catch (error: unknown) {
    abortIfRequested(signal);
    // Errors from loading the author's module can carry local paths or secrets: only SDK messages pass.
    return { check: "lock", status: "failed", message: error instanceof VMError ? error.message : `project configuration ${basename(project)} or its lock could not be read` };
  }
}

/** The browser runner reports the lock check as not configured; the Node-side result replaces it. */
function withLockCheck(report: DoctorReport, lock: DoctorCheckResult): DoctorReport {
  const checks = report.checks.map(check => check.check === "lock" ? lock : check);
  return decodeDoctorReport({ result: checks.some(check => check.status === "failed") ? "failed" : "passed", url: report.url, hosting: report.hosting, checks });
}

/** Probe a real deployed origin in a real browser without running build instructions. */
export async function doctorProject(value: string, options: DoctorOptions): Promise<DoctorReport> {
  let url: URL;
  try { url = new URL(value); } catch { throw new VMError("INVALID_ARGUMENT", "doctor requires an absolute application URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") throw new VMError("INVALID_ARGUMENT", "doctor requires an HTTP(S) URL without credentials");
  if (options.previewOrigin !== undefined) {
    const preview = new URL(options.previewOrigin);
    if (preview.origin !== options.previewOrigin || !isTrustworthyURL(preview)) throw new VMError("INVALID_ARGUMENT", "preview must be a secure origin or localhost origin");
  }
  const hosting: unknown = options.hosting;
  if (hosting !== undefined && hosting !== "frame" && hosting !== "self-hosted") throw new VMError("INVALID_ARGUMENT", "doctor hosting must be frame or self-hosted");
  if (options.frameOrigin !== undefined) {
    if (hosting === "self-hosted") throw new VMError("INVALID_ARGUMENT", "a runtime frame origin applies only to frame hosting");
    let frame: URL;
    try { frame = new URL(options.frameOrigin); } catch { throw new VMError("INVALID_ARGUMENT", "the runtime frame must be a secure origin or localhost origin"); }
    if (frame.origin !== options.frameOrigin || !isTrustworthyURL(frame)) throw new VMError("INVALID_ARGUMENT", "the runtime frame must be a secure origin or localhost origin");
  }
  abortIfRequested(options.signal);
  const lock = await doctorLockCheck(options.project, options.signal);
  const module: unknown = await import(new URL("../browser-tools/doctor-browser.js", import.meta.url).href);
  if (!isRunner(module)) throw new VMError("FEATURE_NOT_AVAILABLE", "browser doctor adapter is unavailable");
  const root = fileURLToPath(new URL("../../assets/doctor/", import.meta.url));
  const artifacts: { relative: string; sha256: string }[] = [];
  async function enumerate(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await enumerate(path);
      else if (entry.isFile() && !path.endsWith(".map")) artifacts.push({ relative: path, sha256: await hashFile(await localBundlePath(root, path), options.signal) });
      else if (!entry.isFile()) throw new VMError("PROTOCOL_ERROR", "doctor assets must be regular files");
    }
  }
  await enumerate("");
  const profile = await mkdtemp(join(tmpdir(), "oxidevm-doctor-"));
  try { return withLockCheck(decodeDoctorReport(await module.runDoctorBrowser(url.href, options, profile, artifacts, getSDKRelease().engineRelease)), lock); }
  finally { await rm(profile, { recursive: true, force: true }); }
}
