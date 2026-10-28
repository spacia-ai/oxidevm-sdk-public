// Maintainer-only: pins one engine release built by the engine repository (`pnpm engine:release`).
// The SDK never contains the engine; this records the release's identity in
// packages/sdk/src/engine.generated.ts and keeps a verified copy in the local engine cache.
//
// usage: pnpm engine:pin <release-dir> [--local-only] [--allow-dirty]
//
// <release-dir> holds release.json, LICENSE and the four modules, plus the assets.json that the
// engine's `pnpm engine:publish` writes after uploading them. --local-only pins a release that has
// not been published: the SDK then records no download location and only --engine-dir,
// OXIDEVM_ENGINE_DIR or the engine cache can supply it. A release built from an engine checkout
// with uncommitted changes (engineSource.dirty) is refused: no commit reproduces it. --allow-dirty
// pins one anyway for local testing, with a warning; pnpm release:local never publishes such a pin.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cdnBaseUrl, copyEngineRelease, decodeEngineAssetUrls, defaultEngineCacheDir, pinEngineRelease, readEngineLicense, verifyEngineRelease } from "../packages/sdk/dist/image-builder/engine-source.js";
import type { EngineDownload, EngineReleasePin } from "../packages/sdk/dist/image-builder/engine-source.js";
import { integer, record } from "../packages/sdk/src/runtime/decode.ts";
import { isEntryPoint } from "./entry-point.ts";

const root = resolve(import.meta.dirname, "..");
const USAGE = "usage: pnpm engine:pin <release-dir> [--local-only] [--allow-dirty]";
const FLAGS = ["--local-only", "--allow-dirty"] as const;
const GENERATED = join(root, "packages/sdk/src/engine.generated.ts");
type Identities = EngineReleasePin["manifest"]["identities"];

export function parseArguments(args: readonly string[]): { readonly directory: string; readonly localOnly: boolean; readonly allowDirty: boolean } {
  const positional = args.filter(argument => !FLAGS.some(flag => flag === argument));
  const [directory] = positional;
  if (directory === undefined || positional.length !== 1 || directory.startsWith("--") || FLAGS.some(flag => args.filter(argument => argument === flag).length > 1)) throw new Error(USAGE);
  return { directory: resolve(directory), localOnly: args.includes("--local-only"), allowDirty: args.includes("--allow-dirty") };
}

/** The SDK's compiled ABI identities, read from their owners' sources (Node strips their types). */
export async function sdkIdentities(): Promise<Identities> {
  async function constant(path: string, name: string): Promise<number> {
    const module: unknown = await import(pathToFileURL(join(root, path)).href);
    return integer(record(module, path)[name], `${path} ${name}`, 0, 0xffff_ffff);
  }
  return {
    coreApi: await constant("packages/sdk/src/runtime/core-abi.ts", "CORE_API_VERSION"),
    jitAbi: await constant("packages/sdk/src/runtime/core-abi/jit.ts", "JIT_API_VERSION"),
    userspaceApi: await constant("packages/sdk/src/runtime/userspace-abi.ts", "USERSPACE_API_VERSION"),
    netstackApi: await constant("packages/sdk/src/runtime/netstack-abi.ts", "NETSTACK_API_VERSION"),
  };
}

// Node supplies WebAssembly at runtime; keep its edge out of the Node-only type graph.
function validator(): (bytes: Uint8Array) => unknown {
  const globals: unknown = globalThis;
  const namespace: unknown = typeof globals === "object" && globals !== null && "WebAssembly" in globals ? globals.WebAssembly : undefined;
  const validate: unknown = typeof namespace === "object" && namespace !== null && "validate" in namespace ? namespace.validate : undefined;
  if (typeof validate !== "function") throw new Error("Node WebAssembly validation is unavailable");
  return bytes => {
    const valid: unknown = Reflect.apply(validate, namespace, [bytes]);
    return valid;
  };
}

async function downloadLocation(directory: string, id: string, localOnly: boolean): Promise<EngineDownload | null> {
  if (localOnly) return null;
  // A release published to Spacia's CDN (engine:publish:cdn) records cdn.json; it wins over the
  // private release channel because anyone can download it.
  const cdn = await readFile(join(directory, "cdn.json"), "utf8").catch(() => undefined);
  if (cdn !== undefined) {
    let value: unknown;
    try { value = JSON.parse(cdn); } catch (error: unknown) { throw new Error(`${join(directory, "cdn.json")} is not JSON`, { cause: error }); }
    if (typeof value !== "object" || value === null || Reflect.get(value, "schemaVersion") !== 1 || Object.keys(value).length !== 2) throw new Error(`${join(directory, "cdn.json")} must be { schemaVersion: 1, baseUrl }`);
    return { kind: "cdn", release: `engine-${id}`, baseUrl: cdnBaseUrl(Reflect.get(value, "baseUrl"), id) };
  }
  let text: string;
  try { text = await readFile(join(directory, "assets.json"), "utf8"); }
  catch (error: unknown) {
    throw new Error(`${join(directory, "assets.json")} cannot be read: publish the release with pnpm engine:publish in the engine repository, or pass --local-only to pin it without a download location`, { cause: error });
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error: unknown) { throw new Error(`${join(directory, "assets.json")} is not JSON`, { cause: error }); }
  return { kind: "github-release-assets", release: `engine-${id}`, assets: decodeEngineAssetUrls(value) };
}

/** The generated module: the release ID, release.json's exact content, the LICENSE identity and the download location. */
export function generatedSource(pin: EngineReleasePin, compliance: { readonly url: string; readonly bytes: number; readonly sha256: string } | null = null): string {
  return `// Generated by scripts/engine-pin.ts; do not edit. Re-pin with \`pnpm engine:pin <release-dir>\`.
// The SDK contains no engine binaries. These values name the one engine release it fetches and
// verifies: engineReleaseId is the SHA-256 of release.json's exact bytes, which are
// JSON.stringify(engineRelease, null, 2) followed by one newline. engineLicense identifies the
// release's LICENSE, which release.json does not cover.
export const engineReleaseId = ${JSON.stringify(pin.id)};
export const engineRelease = ${JSON.stringify(pin.manifest, null, 2)} as const;
export const engineLicense = ${JSON.stringify(pin.license, null, 2)} as const;
export const engineDownload = ${pin.download === null ? "null" : `${JSON.stringify(pin.download, null, 2)} as const`};
export const engineCompliance: unknown = ${JSON.stringify(compliance, null, 2)};
`;
}

export interface PinEngineOptions {
  readonly directory: string;
  readonly localOnly: boolean;
  /** Where the generated module is written; the SDK's own by default. */
  readonly generatedPath?: string;
  /** The engine cache that receives a verified copy; `defaultEngineCacheDir()` by default. */
  readonly cacheDir?: string;
  /** Pin a release built from an engine checkout with uncommitted changes (`--allow-dirty`), with a warning. */
  readonly allowDirty?: boolean;
  /** Receives that warning; standard error by default. */
  readonly warn?: (message: string) => void;
}

/** Verifies the release in `directory` against this SDK, caches it and writes the generated pin. Writes nothing on failure. */
export async function pinEngine(options: PinEngineOptions): Promise<{ readonly pin: EngineReleasePin; readonly cached: string }> {
  const { directory, localOnly } = options;
  const releaseJson = await readFile(join(directory, "release.json"));
  const license = await readEngineLicense(directory);
  const local = pinEngineRelease(releaseJson, license, null);
  const { commit, dirty } = local.manifest.engineSource;
  if (dirty && options.allowDirty !== true) {
    throw new Error(`Engine release ${local.id} was built from engine commit ${commit} with uncommitted changes, so no commit reproduces it. Build the release from a clean engine checkout (pnpm engine:release), or pass --allow-dirty to pin it for local testing only; pnpm release:local refuses to publish a dirty pin.`);
  }
  const expected = await sdkIdentities();
  const actual = local.manifest.identities;
  if (actual.coreApi !== expected.coreApi || actual.jitAbi !== expected.jitAbi || actual.userspaceApi !== expected.userspaceApi || actual.netstackApi !== expected.netstackApi) {
    throw new Error(`Engine release ${local.id} has identities ${JSON.stringify(actual)}, but this SDK is built for ${JSON.stringify(expected)}: update the SDK's ABI owners together with the engine, or pin a matching release`);
  }
  await verifyEngineRelease(directory, local);
  const validate = validator();
  for (const artifact of local.manifest.artifacts) {
    if (validate(await readFile(join(directory, artifact.name))) !== true) throw new Error(`${artifact.name} of engine release ${local.id} is not a valid WebAssembly module`);
  }
  const pin = pinEngineRelease(releaseJson, license, await downloadLocation(directory, local.id, localOnly));
  const cached = join(options.cacheDir ?? defaultEngineCacheDir(), pin.id);
  await copyEngineRelease(directory, cached, pin);
  await writeFile(options.generatedPath ?? GENERATED, generatedSource(pin));
  if (dirty) {
    const warn = options.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
    warn(`Warning: pinned engine release ${pin.id}, built from engine commit ${commit} with uncommitted changes (--allow-dirty). No commit reproduces it; use it for local testing only, because pnpm release:local refuses to publish it.`);
  }
  return { pin, cached };
}

if (isEntryPoint(import.meta.url)) {
  const { pin, cached } = await pinEngine(parseArguments(process.argv.slice(2)));
  const { identities, engineSource } = pin.manifest;
  process.stdout.write(`Pinned engine release ${pin.id} (core ${String(identities.coreApi)}, JIT ${String(identities.jitAbi)}, Userspace ${String(identities.userspaceApi)}, netstack ${String(identities.netstackApi)}; engine commit ${engineSource.commit}${engineSource.dirty ? ", dirty" : ""}; LICENSE ${String(pin.license.bytes)} bytes).\n`
    + `Download: ${pin.download === null ? "none (--local-only)" : pin.download.release}. Cached at ${cached}.\nRebuild the SDK with pnpm build.\n`);
}
