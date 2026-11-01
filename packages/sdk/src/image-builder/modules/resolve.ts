import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { VMError } from "../../runtime/errors.js";
import type { ModuleSource } from "../../wasm/declaration.js";
import type { LockedModule, LockedSource } from "../../wasm/lock.js";
import type { BlobCache } from "./cache.js";
import type { Fetch } from "./fetch.js";
import { resolveGithubRelease } from "./github.js";
import { refuseLinks } from "./project-files.js";
import { readReleaseDirectory, verifyRelease, type Measured, type VerifiedRelease } from "./release.js";
import { MAX_SUMS_BYTES, sha256Hex } from "./sums.js";
import { MAX_MANIFEST_BYTES } from "../../wasm/manifest.js";

/** A release found and verified, with where each of its files can be read from. */
export interface Resolution {
  readonly release: VerifiedRelease;
  /** What the lock records about where the release came from. */
  readonly source: LockedSource;
  /** Release file name to the verified file on disk (the adapter and every artifact). */
  readonly paths: ReadonlyMap<string, string>;
}

export interface ResolveContext {
  readonly projectDir: string;
  readonly cache: BlobCache;
  readonly token?: string | undefined;
  readonly fetchImpl?: Fetch;
  readonly offline?: boolean;
  readonly signal?: AbortSignal;
}

function lockMismatch(message: string): never {
  throw new VMError("PROTOCOL_ERROR", message, { reason: "wasm-lock-mismatch" });
}

/** Finds a release by its declared source and verifies it; nothing is trusted yet. */
export async function resolveSource(source: ModuleSource, context: ResolveContext, expectedRelease?: string): Promise<Resolution> {
  if (source.kind === "file") {
    const directory = isAbsolute(source.path) ? source.path : resolvePath(context.projectDir, source.path);
    if (!isAbsolute(source.path)) await refuseLinks(context.projectDir, source.path, "a local source must be a real directory of the project, so that the lock holds wherever the project is cloned");
    const read = await readReleaseDirectory(directory, context.signal);
    return { release: read, source: { kind: "file", path: source.path }, paths: new Map(read.files.map(file => [file.name, join(directory, file.name)])) };
  }
  if (context.offline === true) throw new VMError("STORAGE_NOT_FOUND", `${source.owner}/${source.repo}@${source.tag} needs the network and it is off`, { reason: "wasm-cache-miss" });
  const found = await resolveGithubRelease({ owner: source.owner, repo: source.repo, tag: source.tag }, {
    cache: context.cache, token: context.token, ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }), ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(expectedRelease === undefined ? {} : { expectedRelease }),
  });
  return { release: found.release, paths: found.paths, source: { kind: "github", repository: `${source.owner}/${source.repo}`, tag: source.tag, commit: found.commit, immutable: found.immutable, attested: found.attested } };
}

/** The lock entry for a resolution, with the capabilities the user consented to. */
export function lockedModule(resolution: Resolution): LockedModule {
  const { release } = resolution;
  const { manifest } = release;
  return {
    source: resolution.source,
    version: manifest.version,
    manifestSha256: sha256Hex(release.manifestBytes),
    adapter: { sha256: manifest.adapter.sha256, bytes: manifest.adapter.bytes },
    artifacts: manifest.artifacts.map(artifact => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes })),
    capabilities: manifest.requires.host,
    release: release.id,
  };
}

/** Rebuilds a locked release from the cache alone; `undefined` when anything is missing. */
async function fromCache(entry: LockedModule, context: ResolveContext): Promise<Resolution | undefined> {
  const manifestBytes = await context.cache.readBytes(entry.manifestSha256, MAX_MANIFEST_BYTES), sumsBytes = await context.cache.readBytes(entry.release, MAX_SUMS_BYTES);
  if (manifestBytes === undefined || sumsBytes === undefined) return undefined;
  const paths = new Map<string, string>(), measured: Measured[] = [];
  for (const pin of [{ name: "adapter.mjs", ...entry.adapter }, ...entry.artifacts]) {
    const path = await context.cache.find(pin.sha256, pin.bytes, context.signal);
    if (path === undefined) return undefined;
    paths.set(pin.name, path);
    measured.push({ name: pin.name, sha256: pin.sha256, bytes: pin.bytes });
  }
  return { release: verifyRelease(manifestBytes, sumsBytes, measured), source: entry.source, paths };
}

function declaredSource(source: LockedSource): ModuleSource {
  if (source.kind === "file") return { kind: "file", path: source.path };
  const [owner, repo] = source.repository.split("/");
  if (owner === undefined || repo === undefined) return lockMismatch("the lock names an invalid repository");
  return { kind: "github", owner, repo, tag: source.tag };
}

/**
 * Finds the release a lock entry pins. A GitHub release comes from the cache when it is all there, so staging works
 * offline; otherwise it is fetched again and must be byte-for-byte the release that was locked, on the same commit.
 */
export async function resolveLocked(entry: LockedModule, context: ResolveContext): Promise<Resolution> {
  if (entry.source.kind === "github") {
    const cached = await fromCache(entry, context);
    if (cached !== undefined) return cached;
    if (context.offline === true) throw new VMError("STORAGE_NOT_FOUND", `${entry.source.repository}@${entry.source.tag} is not fully in the module cache and the network is off`, { reason: "wasm-cache-miss" });
  }
  const resolution = await resolveSource(declaredSource(entry.source), context, entry.release);
  if (resolution.release.id !== entry.release || sha256Hex(resolution.release.manifestBytes) !== entry.manifestSha256) {
    lockMismatch(`${entry.source.kind === "github" ? `${entry.source.repository}@${entry.source.tag}` : entry.source.path} no longer matches the release that was locked: run "oxidevm wasm add" again to review and re-lock it`);
  }
  if (entry.source.kind === "github" && resolution.source.kind === "github" && resolution.source.commit !== entry.source.commit) {
    lockMismatch(`tag ${entry.source.tag} of ${entry.source.repository} now points at a different commit than the one that was locked`);
  }
  return resolution;
}

