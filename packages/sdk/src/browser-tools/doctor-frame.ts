import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import type { DoctorCheck, DoctorReport } from "../contracts/doctor.js";
import { DOCTOR_FRAME_PROBE, decodeFrameMountProbe, decodeFramePageProbe } from "../contracts/doctor-frame.js";
import type { FrameMountProbe, FramePageProbe } from "../contracts/doctor-frame.js";
import { engineRelease, engineReleaseId } from "../engine.generated.js";
import { runtimeFrameEngineUrl, runtimeFrameUrl } from "../frame/location.js";
import { requestCause } from "../image-builder/doctor-failures.js";
import { hash } from "../image-builder/files.js";

// The doctor for an application on the hosted runtime frame (ADR 0021). Such an application serves only its page;
// the runtime, its workers and its storage live in the frame of this SDK release. So the doctor checks what the
// application owns, in its own page (secure context, cross-origin isolation, browser features, and whether its
// Content-Security-Policy and permissions let the frame in and the frame accepts it), and the frame's engine files.
// Worker loading and storage happen inside the frame: those checks are not applicable to the application.

type Check = DoctorReport["checks"][number];

/** Whether the runtime frame's page was served to the doctor, and if so what mounting it in the application showed. */
export type FrameReach = { readonly kind: "not-served"; readonly cause: string } | { readonly kind: "mounted"; readonly mount: FrameMountProbe };
/** One pinned engine file as the runtime frame serves it. */
export type EngineFile = { readonly served: false; readonly cause: string } | { readonly served: true; readonly intact: boolean; readonly wasm: boolean };
export interface FrameObservation {
  readonly frameOrigin: string;
  readonly page: FramePageProbe;
  readonly frame: FrameReach;
  readonly engine: readonly EngineFile[];
}

const passed = (check: DoctorCheck): Check => ({ check, status: "passed" });
const unserved = (files: readonly EngineFile[]) => files.find((file): file is Extract<EngineFile, { readonly served: false }> => !file.served);
const failed = (check: DoctorCheck, message: string): Check => ({ check, status: "failed", message });

function integrity(observed: FrameObservation, frame: string, engine: string): Check {
  if (observed.frame.kind === "not-served") return failed("asset-integrity", `the runtime frame for this SDK release is not served at ${frame} (${observed.frame.cause})`);
  const mount = observed.frame.mount;
  if (mount.kind === "failed") {
    return failed("asset-integrity", mount.blockedBy === null ? `the runtime frame at ${frame} did not accept the application page: ${mount.message}` : `the runtime frame at ${frame} did not load: the application's Content-Security-Policy (${mount.blockedBy}) blocks it`);
  }
  if (mount.engineReleaseId !== engineReleaseId) return failed("asset-integrity", `the runtime frame at ${frame} runs engine release ${mount.engineReleaseId}, not this SDK release's ${engineReleaseId}`);
  const missing = unserved(observed.engine);
  if (missing !== undefined) return failed("asset-integrity", `the runtime frame does not serve this SDK release's engine at ${engine} (${missing.cause})`);
  return observed.engine.every(file => file.served && file.intact) ? passed("asset-integrity") : failed("asset-integrity", `the runtime frame's engine files at ${engine} differ from this SDK release's pins`);
}

function mime(observed: FrameObservation, engine: string): Check {
  const missing = unserved(observed.engine);
  if (missing !== undefined) return failed("wasm-mime", `the runtime frame does not serve this SDK release's engine at ${engine} (${missing.cause})`);
  return observed.engine.every(file => file.served && file.wasm) ? passed("wasm-mime") : failed("wasm-mime", `the runtime frame serves its engine at ${engine} without Content-Type application/wasm`);
}

function contentSecurityPolicy(observed: FrameObservation, frame: string): Check {
  if (observed.frame.kind === "not-served") return failed("content-security-policy", `the runtime frame is not served at ${frame}, so the application's Content-Security-Policy was not checked against it`);
  const mount = observed.frame.mount;
  return mount.kind === "failed" && mount.blockedBy !== null ? failed("content-security-policy", `the application's Content-Security-Policy (${mount.blockedBy}) blocks the runtime frame ${observed.frameOrigin}`) : passed("content-security-policy");
}

/** The browser checks of a frame-hosted application, in `DOCTOR_CHECKS` order, from what the doctor observed. */
export function frameChecks(observed: FrameObservation): Check[] {
  const frame = runtimeFrameUrl(observed.frameOrigin), engine = runtimeFrameEngineUrl(frame, engineReleaseId), page = observed.page;
  return [
    page.secureContext ? passed("secure-context") : failed("secure-context", "the application page is not a secure context; serve it over HTTPS or from localhost"),
    page.crossOriginIsolated ? passed("cross-origin-isolation") : failed("cross-origin-isolation", "the application page is not cross-origin isolated; serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp or credentialless"),
    page.missingFeatures.length === 0 ? passed("wasm-features") : failed("wasm-features", `this browser lacks features OxideVM requires: ${page.missingFeatures.join(", ")}`),
    { check: "worker-load", status: "not-applicable" },
    integrity(observed, frame, engine),
    mime(observed, engine),
    contentSecurityPolicy(observed, frame),
    { check: "storage", status: "not-applicable" },
  ];
}

async function engineFile(context: BrowserContext, engine: string, artifact: { readonly name: string; readonly bytes: number; readonly sha256: string }): Promise<EngineFile> {
  try {
    const response = await context.request.get(new URL(artifact.name, engine).href, { timeout: 60_000 });
    if (!response.ok()) return { served: false, cause: requestCause(response.status()) };
    const body = await response.body();
    return { served: true, intact: body.byteLength === artifact.bytes && hash(body) === artifact.sha256, wasm: response.headers()["content-type"]?.split(";")[0]?.trim() === "application/wasm" };
  } catch (error: unknown) { return { served: false, cause: requestCause(error) }; }
}

/** Calls one function of the frame probe the doctor evaluated in the page; what it returns is decoded by the caller. */
function callProbe(page: Page, name: "page" | "frame", argument: readonly string[]): Promise<unknown> {
  return page.evaluate(async ({ key, name, argument }) => {
    const probe: unknown = Reflect.get(globalThis, Symbol.for(key));
    const run: unknown = typeof probe === "object" && probe !== null ? Reflect.get(probe, name) : undefined;
    if (typeof run !== "function") throw new Error("the doctor's frame probe did not load");
    const result: unknown = await Reflect.apply(run, undefined, argument);
    return result;
  }, { key: DOCTOR_FRAME_PROBE, name, argument });
}

async function reach(context: BrowserContext, page: Page, frameOrigin: string, frame: string): Promise<FrameReach> {
  // Asking for the frame first names a frame that is not deployed instead of waiting for it to answer in the page.
  let status: number;
  try { status = (await context.request.get(frame, { timeout: 30_000 })).status(); }
  catch (error: unknown) { return { kind: "not-served", cause: requestCause(error) }; }
  if (status < 200 || status > 299) return { kind: "not-served", cause: requestCause(status) };
  return { kind: "mounted", mount: decodeFrameMountProbe(await callProbe(page, "frame", [frameOrigin])) };
}

/** Observes a frame-hosted application: the probe in its page, the runtime frame mounted there, and the frame's engine files. */
export async function observeFrame(context: BrowserContext, page: Page, frameOrigin: string): Promise<FrameObservation> {
  const frame = runtimeFrameUrl(frameOrigin), engine = runtimeFrameEngineUrl(frame, engineReleaseId);
  await page.evaluate(await readFile(new URL("../../assets/doctor-frame/client.js", import.meta.url), "utf8"));
  const observedPage = decodeFramePageProbe(await callProbe(page, "page", []));
  const [reached, files] = await Promise.all([reach(context, page, frameOrigin, frame), Promise.all(engineRelease.artifacts.map(artifact => engineFile(context, engine, artifact)))]);
  return { frameOrigin, page: observedPage, frame: reached, engine: files };
}
