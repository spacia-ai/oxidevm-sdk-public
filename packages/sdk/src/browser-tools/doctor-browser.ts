import { chromium, firefox, webkit } from "playwright";
import type { BrowserContext } from "playwright";
import type { DoctorOptions } from "../image-builder/doctor.js";
import type { DoctorReport } from "../contracts/doctor.js";
import { doctorPreviewFrame } from "../contracts/doctor-url.js";
import { decodeDoctorReport, DOCTOR_CHECKS } from "../contracts/doctor.js";
import { record } from "../runtime/decode.js";
import { abortIfRequested } from "../image-builder/tools.js";
import { hash } from "../image-builder/files.js";
import { VMError } from "../runtime/errors.js";

export async function runDoctorBrowser(url: string, options: DoctorOptions, profile: string, assets: readonly { readonly relative: string; readonly sha256: string }[], release: string): Promise<unknown> {
  const browserType = { chromium, firefox, webkit }[options.browser]; let context: BrowserContext | undefined;
  const interrupt = () => { void context?.close().catch(() => undefined); };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    abortIfRequested(options.signal); context = await browserType.launchPersistentContext(profile, { headless: true });
    const page = await context.newPage(); const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (response === null || !response.ok()) throw new VMError("STORAGE_ERROR", "doctor could not load the application URL");
    const baseValue = await page.locator('meta[name="oxidevm-assets"]').getAttribute("content").catch(() => null);
    const base = new URL(baseValue ?? "/oxidevm/", url); let integrity = true;
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
    let checks: DoctorReport["checks"][number][];
    try {
      const output = page.locator('#oxidevm-doctor[data-done="true"]'); await output.waitFor({ timeout: 90_000 });
      const raw: unknown = JSON.parse(await output.textContent() ?? "null") as unknown;
      const parsed = decodeDoctorReport({ result: Array.isArray(raw) && raw.some((value: unknown) => typeof value === "object" && value !== null && "status" in value && value.status === "failed") ? "failed" : "passed", url, checks: [...(Array.isArray(raw) ? Array.from<unknown>(raw) : []), { check: "preview-origin", status: "not-configured" }] });
      checks = [...parsed.checks];
    } catch {
      checks = DOCTOR_CHECKS.map(check => check === "preview-origin" ? { check, status: "not-configured" } : { check, status: "failed", message: "deployed browser probe did not load or finish; inspect assets and CSP" });
    }
    if (!integrity || !compatible) checks = checks.map(check => check.check === "asset-integrity" ? { check: check.check, status: "failed", message: "deployed assets differ from this exact installed SDK release" } : check);
    const headers = await response.allHeaders();
    if (headers["cross-origin-opener-policy"] !== "same-origin" || !["require-corp", "credentialless"].includes(headers["cross-origin-embedder-policy"] ?? "")) checks = checks.map(check => check.check === "cross-origin-isolation" ? { check: check.check, status: "failed", message: "application response lacks compatible COOP/COEP headers" } : check);
    if (options.previewOrigin !== undefined) {
      const preview = await probePreview(context, options.previewOrigin, new URL(url).origin);
      checks = checks.map(check => check.check === "preview-origin" ? preview : check);
    }
    abortIfRequested(options.signal);
    return { result: checks.some(check => check.status === "failed") ? "failed" : "passed", url, checks };
  } finally { options.signal?.removeEventListener("abort", interrupt); await context?.close(); }
}

async function probePreview(context: BrowserContext, origin: string, parentOrigin: string): Promise<DoctorReport["checks"][number]> {
  // The packaged preview bootstrap must actually register its worker and request
  // a parent transport. A successful static fetch alone is insufficient.
  const page = await context.newPage();
  try {
    await page.goto(parentOrigin, { waitUntil: "domcontentloaded" });
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
