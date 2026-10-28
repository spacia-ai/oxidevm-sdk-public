import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeDoctorReport } from "../contracts/doctor.js";
import type { DoctorReport } from "../contracts/doctor.js";
import { VMError } from "../runtime/errors.js";
import { localBundlePath } from "./bundle-files.js";
import { hashFile } from "./files.js";
import { getSDKRelease } from "./project.js";
import { abortIfRequested } from "./tools.js";
import { isTrustworthyURL } from "../trustworthy-url.js";

export interface DoctorOptions { readonly browser: "chromium" | "firefox" | "webkit"; readonly previewOrigin?: string; readonly signal?: AbortSignal }
interface DoctorRunner { runDoctorBrowser(url: string, options: DoctorOptions, profile: string, assets: readonly { readonly relative: string; readonly sha256: string }[], engineRelease: string): Promise<unknown> }
function isRunner(value: unknown): value is DoctorRunner { return typeof value === "object" && value !== null && "runDoctorBrowser" in value && typeof value.runDoctorBrowser === "function"; }

/** Probe a real deployed origin in a real browser without running build instructions. */
export async function doctorProject(value: string, options: DoctorOptions): Promise<DoctorReport> {
  let url: URL;
  try { url = new URL(value); } catch { throw new VMError("INVALID_ARGUMENT", "doctor requires an absolute application URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") throw new VMError("INVALID_ARGUMENT", "doctor requires an HTTP(S) URL without credentials");
  if (options.previewOrigin !== undefined) {
    const preview = new URL(options.previewOrigin);
    if (preview.origin !== options.previewOrigin || !isTrustworthyURL(preview)) throw new VMError("INVALID_ARGUMENT", "preview must be a secure origin or localhost origin");
  }
  abortIfRequested(options.signal);
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
  try { return decodeDoctorReport(await module.runDoctorBrowser(url.href, options, profile, artifacts, getSDKRelease().engineRelease)); }
  finally { await rm(profile, { recursive: true, force: true }); }
}
