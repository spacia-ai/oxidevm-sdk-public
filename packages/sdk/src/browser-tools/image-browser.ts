import { chromium, firefox, webkit } from "playwright";
import type { BrowserContext } from "playwright";
import type { ImageBrowserRunner } from "../image-builder/browser-automation.js";
import { abortIfRequested } from "../image-builder/tools.js";
import { VMError } from "../runtime/errors.js";

export const runImageBrowser: ImageBrowserRunner["runImageBrowser"] = async (origin, browser, profile, signal) => {
  const browserType = browser === "chromium" ? chromium : browser === "firefox" ? firefox : webkit;
  let context: BrowserContext | undefined;
  const abort = () => { void context?.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    abortIfRequested(signal); context = await browserType.launchPersistentContext(profile, { headless: true }); abortIfRequested(signal);
    const launched = context.browser();
    if (launched === null) throw new VMError("FEATURE_NOT_AVAILABLE", "image test could not read the launched browser identity");
    const page = await context.newPage(); await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const result = page.locator('#oxidevm-qualification[data-done="true"]'); await result.waitFor({ state: "attached", timeout: 900_000 });
    const checks: unknown = JSON.parse(await result.textContent() ?? "null") as unknown;
    abortIfRequested(signal);
    return { version: launched.version(), checks };
  } finally { signal?.removeEventListener("abort", abort); await context?.close(); }
};
