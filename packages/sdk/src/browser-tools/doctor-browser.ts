import { chromium, firefox, webkit } from "playwright";
import type { BrowserContext, Page } from "playwright";
import type { DoctorOptions } from "../image-builder/doctor.js";
import type { DoctorHosting, DoctorReport } from "../contracts/doctor.js";
import { doctorPreviewFrame } from "../contracts/doctor-url.js";
import { decodeDoctorReport, DOCTOR_CHECKS, isFrameOwnedCheck } from "../contracts/doctor.js";
import { DEFAULT_FRAME_ORIGIN, runtimeFrameUrl } from "../frame/location.js";
import { record } from "../runtime/decode.js";
import { abortIfRequested } from "../image-builder/tools.js";
import { hash } from "../image-builder/files.js";
import { browserStartFailure, navigationFailure } from "../image-builder/doctor-failures.js";
import { frameChecks, observeFrame } from "./doctor-frame.js";

type Check = DoctorReport["checks"][number];
type DoctorAssets = readonly { readonly relative: string; readonly sha256: string }[];

export async function runDoctorBrowser(url: string, options: DoctorOptions, profile: string, assets: DoctorAssets, release: string): Promise<unknown> {
  const browserType = { chromium, firefox, webkit }[options.browser]; let context: BrowserContext | undefined;
  const interrupt = () => { void context?.close().catch(() => undefined); };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    abortIfRequested(options.signal);
    try { context = await browserType.launchPersistentContext(profile, { headless: true }); }
    catch { abortIfRequested(options.signal); throw browserStartFailure(options.browser); }
    const page = await context.newPage();
    let response: Awaited<ReturnType<typeof page.goto>>;
    try { response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch (error) { abortIfRequested(options.signal); throw navigationFailure(url, error); }
    if (response === null || !response.ok()) throw navigationFailure(url, response?.status());
    // The parsed document already holds a declared asset base; a page without one has nothing to wait for.
    const declared = page.locator('meta[name="oxidevm-assets"]');
    const baseValue = await declared.count() === 0 ? null : await declared.first().getAttribute("content").catch(() => null);
    const base = new URL(baseValue ?? "/oxidevm/", url);
    const frameOrigin = options.frameOrigin ?? DEFAULT_FRAME_ORIGIN;
    const hosting: DoctorHosting = (options.hosting ?? await servedHosting(context, base)) === "self-hosted" ? { kind: "self-hosted", assets: base.href } : { kind: "frame", frame: runtimeFrameUrl(frameOrigin) };
    let checks = hosting.kind === "self-hosted" ? await selfHostedChecks(context, page, url, base, assets, release) : await frameHostedChecks(context, page, frameOrigin);
    const headers = await response.allHeaders();
    if (headers["cross-origin-opener-policy"] !== "same-origin" || !["require-corp", "credentialless"].includes(headers["cross-origin-embedder-policy"] ?? "")) checks = checks.map(check => check.check === "cross-origin-isolation" ? { check: check.check, status: "failed", message: "application response lacks compatible COOP/COEP headers" } : check);
    if (options.previewOrigin !== undefined) {
      const preview = await probePreview(context, options.previewOrigin, new URL(url).origin);
      checks = checks.map(check => check.check === "preview-origin" ? preview : check);
    }
    abortIfRequested(options.signal);
    return { result: checks.some(check => check.status === "failed") ? "failed" : "passed", url, hosting, checks };
  } finally { options.signal?.removeEventListener("abort", interrupt); await context?.close(); }
}

/**
 * Without an explicit hosting option: a self-hosted runtime when the application serves the SDK's doctor probe at its
 * asset base, otherwise the hosted runtime frame, the only runtime such an application can run. An HTML answer is a
 * single-page application's fallback, not the probe.
 */
async function servedHosting(context: BrowserContext, base: URL): Promise<"self-hosted" | "frame"> {
  try {
    const probe = await context.request.get(new URL("doctor/client.js", base).href, { timeout: 30_000 });
    return probe.ok() && !(probe.headers()["content-type"] ?? "").startsWith("text/html") ? "self-hosted" : "frame";
  } catch { return "frame"; }
}

/** The application's own runtime assets, probed by the deployed doctor client exactly as before frame hosting. */
async function selfHostedChecks(context: BrowserContext, page: Page, url: string, base: URL, assets: DoctorAssets, release: string): Promise<Check[]> {
  let integrity = true;
  // Hash actual deployed scripts against this installed SDK's immutable asset set.
  for (const asset of assets) {
    const deployed = await context.request.get(new URL(`doctor/${asset.relative}`, base).href, { timeout: 30_000 });
    if (!deployed.ok() || hash(await deployed.body()) !== asset.sha256) integrity = false;
  }
  const deployedRelease = await context.request.get(new URL("project.json", base).href, { timeout: 30_000 });
  let compatible = false;
  if (deployedRelease.ok()) { const metadata: unknown = await deployedRelease.json(); compatible = record(metadata, "deployed SDK release")["engineRelease"] === release; }
  await page.evaluate(scriptURL => {
    const script = document.createElement("script"); script.type = "module"; script.src = scriptURL; document.body.append(script);
  }, new URL("doctor/client.js", base).href);
  // The page runs neither the preview nor the lock check: preview-origin is probed by the caller, and doctorProject
  // replaces the lock check with the project's own, which runs in Node.
  let checks: Check[];
  try {
    const output = page.locator('#oxidevm-doctor[data-done="true"]'); await output.waitFor({ timeout: 90_000 });
    const raw: unknown = JSON.parse(await output.textContent() ?? "null") as unknown;
    const parsed = decodeDoctorReport({ result: Array.isArray(raw) && raw.some((value: unknown) => typeof value === "object" && value !== null && "status" in value && value.status === "failed") ? "failed" : "passed", url, hosting: { kind: "self-hosted", assets: base.href }, checks: [...(Array.isArray(raw) ? Array.from<unknown>(raw) : []), { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "not-configured" }] });
    checks = [...parsed.checks];
  } catch {
    checks = DOCTOR_CHECKS.map(check => check === "preview-origin" || check === "lock" ? { check, status: "not-configured" } : { check, status: "failed", message: "deployed browser probe did not load or finish; inspect assets and CSP" });
  }
  return !integrity || !compatible ? checks.map(check => check.check === "asset-integrity" ? { check: check.check, status: "failed", message: "deployed assets differ from this exact installed SDK release" } : check) : checks;
}

/** The application's page and this SDK release's hosted runtime frame in it (ADR 0021); see doctor-frame.ts. */
async function frameHostedChecks(context: BrowserContext, page: Page, frameOrigin: string): Promise<Check[]> {
  let browser: Check[];
  try { browser = frameChecks(await observeFrame(context, page, frameOrigin)); }
  catch {
    browser = DOCTOR_CHECKS.flatMap((check): Check[] => check === "preview-origin" || check === "lock" ? []
      : isFrameOwnedCheck(check) ? [{ check, status: "not-applicable" }] : [{ check, status: "failed", message: "the doctor's runtime frame probe did not run in the application page" }]);
  }
  return [...browser, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "not-configured" }];
}

async function probePreview(context: BrowserContext, origin: string, parentOrigin: string): Promise<Check> {
  // The packaged preview bootstrap must actually register its worker and request
  // a parent transport. A successful static fetch alone is insufficient.
  const page = await context.newPage();
  try {
    await page.goto(parentOrigin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const session = crypto.randomUUID().replaceAll("-", "");
    const location = doctorPreviewFrame(origin, parentOrigin, session);
    const result = await page.evaluate(async ({ previewOrigin, url, session }) => {
      return await new Promise<boolean>(resolve => {
        const frame = document.createElement("iframe"); const timer = setTimeout(() => finish(false), 15_000);
        const finish = (result: boolean) => { clearTimeout(timer); window.removeEventListener("message", receive); frame.remove(); resolve(result); };
        const receive = (event: MessageEvent<unknown>) => {
          if (event.origin !== previewOrigin || event.source !== frame.contentWindow || typeof event.data !== "object" || event.data === null || !("kind" in event.data) || !("session" in event.data) || event.data.session !== session) return;
          if (event.data.kind === "oxidevm-preview-connect") finish(true);
          else if (event.data.kind === "oxidevm-preview-failed") finish(false);
        };
        window.addEventListener("message", receive);
        frame.src = url;
        document.body.append(frame);
      });
    }, { previewOrigin: location.origin, url: location.url, session });
    return result ? { check: "preview-origin", status: "passed" } : { check: "preview-origin", status: "failed", message: "preview bootstrap did not register its worker and request a transport" };
  } catch { return { check: "preview-origin", status: "failed", message: "preview origin could not complete its actual bootstrap" }; }
  finally { await page.close(); }
}
