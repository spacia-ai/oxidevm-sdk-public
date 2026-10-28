import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isImageRef } from "../image.js";
import { decodeImageSmokeTest } from "../image-smoke.js";
import { record, string } from "../runtime/decode.js";
import { VMError, serializeUnknownError } from "../runtime/errors.js";
import type { BrowserImageTestOptions, ImageCheckResult, ImageTestReport } from "./contracts.js";
import { inspectImage, readImageBundle } from "./bundle.js";
import { artifactRelativePath, decodeBundleJSON, readBundleFile } from "./bundle-files.js";
import { startImageTestServer } from "./image-test-server.js";
import { decodeImageCheckResult, decodeImageTestReport } from "./reports.js";
import { abortIfRequested } from "./tools.js";
import { loadImageBrowserRunner } from "./browser-automation.js";
import type { ImageTestServer } from "./image-test-server.js";
import { validateDistributionBundle } from "./distribution-validation.js";
import { resolveEngineDirectory } from "./engine-source.js";
import { getSDKRelease } from "./project.js";
import { pinnedEngineCompliance, resolveEngineCompliance } from "./engine-compliance.js";

export async function testImage(bundleDir: string, options: BrowserImageTestOptions): Promise<ImageTestReport> {
  abortIfRequested(options.signal);
  if (!isImageRef(options.image, "system") && !isImageRef(options.image, "userspace")) throw new VMError("INVALID_ARGUMENT", "testImage requires an image reference created by defineImage");
  const purpose: unknown = options.purpose;
  if (!["chromium", "firefox", "webkit"].includes(options.browser) || purpose !== undefined && purpose !== "development" && purpose !== "distribution") throw new VMError("INVALID_ARGUMENT", "invalid browser image-test options");
  const read = await readImageBundle(bundleDir, options.image.trust, options.signal);
  if (read.image.manifestSHA256 !== options.image.manifestSHA256 || read.image.mode !== options.image.mode || read.image.manifestUrl !== options.image.manifestUrl) throw new VMError("PROTOCOL_ERROR", "test bundle differs from the explicitly pinned image reference");
  await inspectImage(bundleDir, { trust: options.image.trust, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const provenance = read.manifest.provenance;
  if (provenance === undefined) throw new VMError("PROTOCOL_ERROR", "image is missing signed test metadata");
  const metadata = record(decodeBundleJSON(await readBundleFile(read.bundle, artifactRelativePath(read.base, provenance.reproducibility.url), Math.min(provenance.reproducibility.bytes, 16 * 1024 ** 2), options.signal)), "signed build/test metadata");
  const smokeTest = decodeImageSmokeTest(metadata["smokeTest"]);
  let validationFailure: string | undefined;
  if (options.purpose === "distribution") {
    try { await validateDistributionBundle(read, options.signal); }
    catch (error) { abortIfRequested(options.signal); validationFailure = error instanceof Error ? error.message.slice(0, 4096) : "distribution evidence validation failed"; }
  }
  const evidenceCheck = (check: "license-evidence" | "reproducible-build"): ImageCheckResult => options.purpose !== "distribution"
    ? { check, status: "not-applicable", reason: "not-declared" }
    : validationFailure === undefined ? { check, status: "passed" } : { check, status: "failed", message: validationFailure };
  const license = evidenceCheck("license-evidence"); const reproduction = evidenceCheck("reproducible-build");
  const engineDir = await resolveEngineDirectory({ ...(options.engineDir === undefined ? {} : { engineDir: options.engineDir }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const compliance = pinnedEngineCompliance();
  const engineCompliance = compliance === null ? undefined : { sha256: compliance.sha256, directory: await resolveEngineCompliance(compliance, getSDKRelease().engineRelease.replace(/^sha256:/u, ""), { engineDirectory: engineDir, ...(options.signal === undefined ? {} : { signal: options.signal }) }) };
  const profile = await mkdtemp(join(tmpdir(), "oxidevm-image-browser-")); let server: ImageTestServer | undefined;
  const manifestPath = read.base.pathname;
  try {
  server = await startImageTestServer({ bundleDir: read.bundle, manifestPath, engineDir, ...(engineCompliance === undefined ? {} : { engineCompliance }), browserDir: fileURLToPath(new URL("../../assets/qualification/", import.meta.url)), configuration: {
    image: { mode: options.image.mode, manifestUrl: manifestPath, manifestSHA256: options.image.manifestSHA256, trust: options.image.trust }, smokeTest, "license-evidence": license, "reproducible-build": reproduction,
  } });
    abortIfRequested(options.signal);
    const runner = await loadImageBrowserRunner(); const browserResult = record(await runner.runImageBrowser(server.origin, options.browser, profile, options.signal), "image browser result");
    const value = browserResult["checks"];
    if (!Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", "image-test browser returned an invalid report");
    const checks = Array.from<unknown>(value).map(decodeImageCheckResult);
    const release = getSDKRelease();
    const report = decodeImageTestReport({ schemaVersion: 1, result: checks.some(check => check.status === "failed") ? "failed" : "passed", mode: options.image.mode, manifestSHA256: options.image.manifestSHA256, engineRelease: release.engineRelease, sdkVersion: release.sdkVersion, browser: { name: options.browser, version: string(browserResult["version"], "actual browser version") }, checks });
    abortIfRequested(options.signal);
    await writeFile(join(read.bundle, "test-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    abortIfRequested(options.signal);
    if (error instanceof VMError) throw error;
    throw new VMError("FEATURE_NOT_AVAILABLE", "the real browser image test could not complete; check the browser installation and runtime assets", { reason: serializeUnknownError(error).message });
  } finally { try { await server?.close(); } finally { await rm(profile, { recursive: true, force: true }); } }
}
