import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineImage, isImageRef, type ImageRef, type TrustedImageKey } from "../../image.js";
import { record, string } from "../../runtime/decode.js";
import { VMError, serializeUnknownError } from "../../runtime/errors.js";
import { decodeWasmPropertyResult, decodeWasmTestReport, type WasmTestReport } from "../../wasm/conformance/report.js";
import { loadImageBrowserRunner } from "../browser-automation.js";
import { readImageBundle } from "../bundle.js";
import { pinnedEngineCompliance, resolveEngineCompliance } from "../engine-compliance.js";
import { resolveEngineDirectory } from "../engine-source.js";
import { startImageTestServer, type ImageTestServer } from "../image-test-server.js";
import { getSDKRelease } from "../project.js";
import { abortIfRequested } from "../tools.js";
import { readReleaseDirectory, type VerifiedRelease } from "./release.js";

export interface ModuleTestOptions {
  /** The Userspace image the page boots: a reference the page loads itself, or a local bundle and its author trust to serve. */
  readonly image: ImageRef<"userspace"> | { readonly bundle: string; readonly trust: TrustedImageKey };
  /** Arguments for a command module's run. */
  readonly args?: readonly string[];
  /** Values for the module's options; defaults apply to the rest. */
  readonly options?: Readonly<Record<string, unknown>>;
  readonly browser: "chromium" | "firefox" | "webkit";
  readonly engineDir?: string;
  /** How long a command may run; two minutes by default. */
  readonly commandMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_COMMAND_MS = 120_000;

/** Launch pins as plain JSON for the page, which decodes them again; the browser-side handle types stay out of the Node graph. */
interface ServedPins {
  readonly release: string;
  readonly adapter: { readonly url: string; readonly sha256: string; readonly bytes: number };
  readonly artifacts: Readonly<Record<string, { readonly url: string; readonly sha256: string; readonly bytes: number }>>;
}

function launchPins(release: VerifiedRelease, base: string): ServedPins {
  const { manifest } = release;
  return {
    release: release.id,
    adapter: { url: `${base}adapter.mjs`, sha256: manifest.adapter.sha256, bytes: manifest.adapter.bytes },
    artifacts: Object.fromEntries(manifest.artifacts.map(artifact => [artifact.name, { url: `${base}${encodeURIComponent(artifact.name)}`, sha256: artifact.sha256, bytes: artifact.bytes }])),
  };
}

/**
 * Runs the runner-contract properties against a built module (`oxidevm wasm build` output) in a real browser,
 * with the pinned engine and a Userspace image. The release is verified before any browser starts.
 */
export async function testModule(directory: string, options: ModuleTestOptions): Promise<WasmTestReport> {
  abortIfRequested(options.signal);
  const requested = options.image;
  if (!("bundle" in requested) && !isImageRef(requested, "userspace")) throw new VMError("INVALID_ARGUMENT", "wasm test needs a Userspace image reference created by defineImage", { reason: "wasm-test-image" });
  const release = await readReleaseDirectory(resolve(directory), options.signal);
  let image: ImageRef<"userspace">, served: Awaited<ReturnType<typeof readImageBundle>> | undefined;
  if ("bundle" in requested) {
    served = await readImageBundle(requested.bundle, requested.trust, options.signal);
    if (served.image.mode !== "userspace") throw new VMError("INVALID_ARGUMENT", "wasm test needs a Userspace image bundle", { reason: "wasm-test-image" });
    image = defineImage({ mode: "userspace", manifestUrl: served.base.pathname, manifestSHA256: served.image.manifestSHA256, trust: requested.trust });
  } else image = requested;
  const engineDir = await resolveEngineDirectory({ ...(options.engineDir === undefined ? {} : { engineDir: options.engineDir }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const compliance = pinnedEngineCompliance();
  const engineCompliance = compliance === null ? undefined : { sha256: compliance.sha256, directory: await resolveEngineCompliance(compliance, getSDKRelease().engineRelease.replace(/^sha256:/u, ""), { engineDirectory: engineDir, ...(options.signal === undefined ? {} : { signal: options.signal }) }) };
  const profile = await mkdtemp(join(tmpdir(), "oxidevm-wasm-test-"));
  let server: ImageTestServer | undefined;
  try {
    const manifestUrl = image.manifestUrl;
    server = await startImageTestServer({
      ...(served === undefined ? {} : { bundleDir: served.bundle, manifestPath: served.base.pathname }),
      engineDir, ...(engineCompliance === undefined ? {} : { engineCompliance }),
      browserDir: fileURLToPath(new URL("../../../assets/qualification/", import.meta.url)), entry: "wasm-client.js",
      module: { directory: release.directory, tamper: "adapter.mjs" },
      configure: origin => ({
        image: { manifestUrl, manifestSHA256: image.manifestSHA256, trust: image.trust },
        module: { manifest: JSON.parse(new TextDecoder().decode(release.manifestBytes)) as unknown, genuine: launchPins(release, `${origin}/module/`), tampered: launchPins(release, `${origin}/module-tampered/`) },
        args: options.args ?? [], options: options.options ?? {}, commandMs: options.commandMs ?? DEFAULT_COMMAND_MS,
      }),
    });
    abortIfRequested(options.signal);
    const runner = await loadImageBrowserRunner();
    const result = record(await runner.runImageBrowser(server.origin, options.browser, profile, options.signal), "wasm test browser result");
    const page = record(result["checks"], "wasm test page result");
    if (page["error"] !== undefined) {
      const failure = record(page["error"], "wasm test page error");
      throw new VMError("FEATURE_NOT_AVAILABLE", `the wasm test page failed: ${string(failure["message"], "page error message").slice(0, 2048)}`, { reason: "wasm-test-page", code: string(failure["code"], "page error code") });
    }
    const listed: unknown = page["properties"];
    if (!Array.isArray(listed)) throw new VMError("PROTOCOL_ERROR", "the wasm test page returned no properties");
    const properties = Array.from<unknown>(listed).map(decodeWasmPropertyResult);
    const sdk = getSDKRelease();
    return decodeWasmTestReport({
      schemaVersion: 1, result: properties.some(property => property.status === "failed") ? "failed" : "passed",
      module: { id: release.manifest.id, version: release.manifest.version, kind: release.manifest.process.kind, release: release.id },
      sdkVersion: sdk.sdkVersion, engineRelease: sdk.engineRelease,
      browser: { name: options.browser, version: string(result["version"], "browser version") },
      image: { manifestSHA256: image.manifestSHA256 }, properties,
    });
  } catch (error: unknown) {
    abortIfRequested(options.signal);
    if (error instanceof VMError) throw error;
    throw new VMError("FEATURE_NOT_AVAILABLE", "the real browser module test could not complete; check the browser installation and runtime assets", { reason: serializeUnknownError(error).message });
  } finally { try { await server?.close(); } finally { await rm(profile, { recursive: true, force: true }); } }
}
