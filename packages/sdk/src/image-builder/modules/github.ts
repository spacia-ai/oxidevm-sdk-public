import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { VMError } from "../../runtime/errors.js";
import { record } from "../../runtime/decode.js";
import { MANIFEST_INVALID } from "../../wasm/decode-support.js";
import type { Tristate } from "../../wasm/lock.js";
import { decodeModuleManifest } from "../../wasm/manifest.js";
import type { BlobCache } from "./cache.js";
import { fetchBytes, fetchJSON, fetchToFile, type Fetch, type FetchOptions, type RedirectPolicy } from "./fetch.js";
import { MAX_RELEASE_BYTES, verifyRelease, type Measured, type VerifiedRelease } from "./release.js";
import { MAX_SUMS_BYTES, parseSums, releaseId } from "./sums.js";

const run = promisify(execFile);
const API = "https://api.github.com";

/** A resolved GitHub release: the verified files, the commit its tag names, and what GitHub says about it. */
export interface GithubRelease {
  readonly release: VerifiedRelease;
  readonly commit: string;
  readonly immutable: Tristate;
  readonly attested: Tristate;
  /** The verified file paths in the cache, by release file name. */
  readonly paths: ReadonlyMap<string, string>;
}

/** HTTPS on port 443 to GitHub's API and download hosts only, by name (so an IP address never qualifies), with no credentials in the URL. */
export const githubRedirects: RedirectPolicy = {
  maxHops: 5,
  allows(url) {
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
    return url.hostname === "api.github.com" || url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com");
  },
};

/** `GITHUB_TOKEN`, then `GH_TOKEN`, then the GitHub CLI's login. It is never logged, stored or put on a command line. */
export async function githubToken(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = environment[name];
    if (value !== undefined && value !== "") return value;
  }
  // Without a home directory the GitHub CLI would write its state into the current directory; there is no login to read either.
  if ((environment["HOME"] ?? environment["USERPROFILE"] ?? "") === "") return undefined;
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 5000, env: { ...environment, GH_PROMPT_DISABLED: "1" } });
    return stdout.trim() === "" ? undefined : stdout.trim();
  } catch { return undefined; }
}

interface ReleaseAsset { readonly name: string; readonly id: number; readonly size: number; readonly digest: string | undefined }

function bad(message: string): never {
  throw new VMError("PROTOCOL_ERROR", `GitHub release ${message}`, { reason: MANIFEST_INVALID });
}

function decodeAsset(value: unknown): ReleaseAsset {
  const item = record(value, "release asset");
  const name: unknown = item["name"], id: unknown = item["id"], size: unknown = item["size"], digest: unknown = item["digest"], state: unknown = item["state"];
  if (typeof name !== "string" || typeof id !== "number" || !Number.isSafeInteger(id) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return bad("has a malformed asset");
  if (state !== undefined && state !== "uploaded") return bad(`asset ${name} is not uploaded`);
  if (digest !== undefined && digest !== null && (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest))) return bad(`asset ${name} has an unsupported digest`);
  return { name, id, size, digest: typeof digest === "string" ? digest.slice(7) : undefined };
}

function decodeRelease(value: unknown): { readonly assets: readonly ReleaseAsset[]; readonly immutable: Tristate } {
  const release = record(value, "release");
  if (release["draft"] !== false) bad("is a draft");
  const assets = release["assets"];
  if (!Array.isArray(assets) || assets.length > 512) return bad("has no asset list");
  const immutable = release["immutable"];
  return { assets: Array.from<unknown>(assets).map(decodeAsset), immutable: immutable === true ? "yes" : immutable === false ? "no" : "unknown" };
}

export interface GithubTarget { readonly owner: string; readonly repo: string; readonly tag: string }
export interface ResolveOptions {
  readonly cache: BlobCache;
  readonly token?: string | undefined;
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
  readonly maxArtifactBytes?: number;
  /** The most all the files of one release may add up to; a release asking for more is refused before any file is fetched. */
  readonly maxReleaseBytes?: number;
  /** The release id a lock pins: a release with another `SHA256SUMS` is refused before any file is fetched. */
  readonly expectedRelease?: string;
}

/** Thirty seconds plus a second per megabyte, so that a large file fails when the link is hopeless, not when it is merely slow. */
export function downloadTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / 1_000_000) * 1_000;
}

/**
 * Resolves `github:owner/repo@tag`: reads the release's `SHA256SUMS` and `module.json`, then fetches every file they pin
 * into the content-addressed cache, checking size and digest as it arrives, and cross-checks GitHub's own asset digests.
 */
export async function resolveGithubRelease(target: GithubTarget, options: ResolveOptions): Promise<GithubRelease> {
  const { owner, repo, tag } = target;
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const authorization = options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` };
  const api = (accept: string): FetchOptions => ({ headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...authorization }, redirect: githubRedirects, timeoutMs: 30_000, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const { assets, immutable } = decodeRelease(await fetchJSON(new URL(`${base}/releases/tags/${encodeURIComponent(tag)}`), 4 * 1024 ** 2, api("application/vnd.github+json")));
  const byName = new Map(assets.map(asset => [asset.name, asset]));
  const download = async (name: string, limit: number): Promise<Uint8Array<ArrayBuffer>> => {
    const asset = byName.get(name);
    if (asset === undefined) return bad(`has no asset ${name}`);
    if (asset.size > limit) bad(`asset ${name} is larger than ${String(limit)} bytes`);
    return fetchBytes(new URL(`${base}/releases/assets/${String(asset.id)}`), limit, api("application/octet-stream"));
  };
  const sumsBytes = await download("SHA256SUMS", MAX_SUMS_BYTES), manifestBytes = await download("module.json", 256 * 1024);
  if (options.expectedRelease !== undefined && releaseId(sumsBytes) !== options.expectedRelease) {
    throw new VMError("PROTOCOL_ERROR", `${owner}/${repo}@${tag} no longer matches the release that was locked: run "oxidevm wasm add" again to review and re-lock it`, { reason: "wasm-lock-mismatch" });
  }
  // Before any file is fetched the release must agree with itself and with GitHub's listing: module.json decodes and is
  // canonical, SHA256SUMS lists exactly its files with the hashes it pins, each asset has the pinned size and GitHub's own
  // digest, and the whole is within budget. A hostile release is refused here, having cost two small requests.
  const manifest = decodeModuleManifest(manifestBytes);
  const pins: Measured[] = [{ name: "adapter.mjs", sha256: manifest.adapter.sha256, bytes: manifest.adapter.bytes }, ...manifest.artifacts.map(artifact => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes }))];
  verifyRelease(manifestBytes, sumsBytes, pins);
  let total = 0;
  for (const pin of pins) {
    const asset = byName.get(pin.name);
    if (asset === undefined) return bad(`has no asset ${pin.name}`);
    if (asset.size !== pin.bytes) bad(`asset ${pin.name} has ${String(asset.size)} bytes where module.json pins ${String(pin.bytes)}`);
    if (asset.digest !== undefined && asset.digest !== pin.sha256) bad(`asset ${pin.name} differs from GitHub's own digest for it`);
    total += pin.bytes;
  }
  const budget = options.maxReleaseBytes ?? MAX_RELEASE_BYTES;
  if (total > budget) bad(`holds ${String(total)} bytes of files, more than the ${String(budget)} bytes this tool will fetch for one release`);
  const sums = new Map(parseSums(sumsBytes).map(entry => [entry.name, entry.sha256]));
  await options.cache.sweepScratch(); // what a killed earlier run left behind
  const paths = new Map<string, string>();
  const measured: Measured[] = [];
  const limit = options.maxArtifactBytes ?? 512 * 1024 ** 2;
  for (const [name, sha256] of sums) {
    if (name === "module.json") continue;
    const asset = byName.get(name);
    if (asset === undefined) return bad(`has no asset ${name}`);
    if (asset.digest !== undefined && asset.digest !== sha256) bad(`asset ${name} differs from GitHub's own digest for it`);
    if (asset.size > limit) bad(`asset ${name} is larger than ${String(limit)} bytes`);
    const cached = await options.cache.find(sha256, asset.size, options.signal);
    if (cached !== undefined) { paths.set(name, cached); measured.push({ name, sha256, bytes: asset.size }); continue; }
    const scratch = options.cache.scratchPath();
    try {
      const done = await fetchToFile(new URL(`${base}/releases/assets/${String(asset.id)}`), { path: scratch, maxBytes: limit, expectedBytes: asset.size, expectedSha256: sha256 }, { ...api("application/octet-stream"), timeoutMs: downloadTimeoutMs(asset.size) });
      paths.set(name, await options.cache.adopt(scratch, sha256));
      measured.push({ name, sha256, bytes: done.bytes });
    } finally { await rm(scratch, { force: true }); }
  }
  const release = verifyRelease(manifestBytes, sumsBytes, measured);
  await options.cache.putBytes(manifestBytes);
  await options.cache.putBytes(sumsBytes);
  const commit = (new TextDecoder().decode(await fetchBytes(new URL(`${base}/commits/${encodeURIComponent(tag)}`), 128, api("application/vnd.github.sha")))).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) bad("tag does not name a commit");
  const attested = await attestation(base, release.id, api("application/vnd.github+json"));
  return { release, commit, immutable, attested, paths };
}

/** Whether GitHub holds a build attestation for the release's `SHA256SUMS`; anything but a clear answer is `unknown`. */
async function attestation(base: string, sumsDigest: string, options: FetchOptions): Promise<Tristate> {
  try {
    const value = await fetchJSON(new URL(`${base}/attestations/sha256:${sumsDigest}`), 4 * 1024 ** 2, options);
    const found = record(value, "attestations")["attestations"];
    return Array.isArray(found) && found.length > 0 ? "yes" : "no";
  } catch (error: unknown) {
    return error instanceof VMError && error.detail?.["status"] === 404 ? "no" : "unknown";
  }
}

