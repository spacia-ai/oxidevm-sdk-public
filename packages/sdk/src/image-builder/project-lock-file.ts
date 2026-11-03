import { randomUUID } from "node:crypto";
import { link, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VMError } from "../runtime/errors.js";
import type { ProjectLockChange } from "./contracts.js";
import { compareProjectLock, createProjectLock, projectLockIdentity, validateProjectLock } from "./project.js";
import type { ProjectLock, ResolvedProjectConfig } from "./project.js";
import { decodeBundleJSON, readBundleFile } from "./bundle-files.js";
import { hash } from "./files.js";
import { abortIfRequested } from "./tools.js";

const LOCK_FILE = "oxidevm.lock.json";
const LOCK_BYTES = 1024 ** 2;

function errorCode(error: unknown): unknown { return typeof error === "object" && error !== null && "code" in error ? error.code : undefined; }

/** The project's `oxidevm.lock.json`, or undefined when it has none. */
export async function readProjectLockFile(directory: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try { return await readBundleFile(directory, LOCK_FILE, LOCK_BYTES, signal); }
  catch (error: unknown) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}

function lockText(lock: ProjectLock): string { return `${JSON.stringify(lock, null, 2)}\n`; }
function changed(): VMError { return new VMError("PERMISSION_DENIED", "oxidevm.lock.json changed while assets were staged; run the command again", { reason: "project-lock-changed" }); }

/** Replaces the lock read as `previous`, or creates it when there was none, in one step and only if it is unchanged. */
async function replaceLock(directory: string, lock: ProjectLock, previous: Uint8Array | undefined, signal?: AbortSignal): Promise<void> {
  const path = join(directory, LOCK_FILE), temporary = `${path}.updating-${randomUUID()}`;
  try {
    await writeFile(temporary, lockText(lock), { flag: "wx" });
    abortIfRequested(signal);
    const current = await readProjectLockFile(directory, signal);
    if (current === undefined ? previous !== undefined : previous === undefined || hash(current) !== hash(previous)) throw changed();
    // link() creates the lock exclusively; rename() replaces the lock that was read before staging.
    if (previous === undefined) await link(temporary, path).catch((error: unknown) => { throw errorCode(error) === "EEXIST" ? changed() : error; });
    else await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** The lock that staging uses, and how `commit` leaves `oxidevm.lock.json` once staging has succeeded. */
export interface ProjectLockSession {
  readonly lock: ProjectLock;
  commit(): Promise<ProjectLockChange>;
}

/**
 * Without `update`, a missing lock is written first, as `oxidevm init` would, and an existing lock must be the one
 * this release writes. With `update`, staging uses this release's lock and `commit` writes it afterwards; a failed or
 * interrupted staging run leaves the old lock in place.
 */
export async function openProjectLock(directory: string, config: ResolvedProjectConfig, update: boolean, signal?: AbortSignal): Promise<ProjectLockSession> {
  const previous = await readProjectLockFile(directory, signal);
  if (!update) {
    // Exclusive creation: a lock written concurrently fails loudly instead of being overwritten.
    if (previous === undefined) await writeFile(join(directory, LOCK_FILE), lockText(createProjectLock(config)), { flag: "wx" });
    const lock = validateProjectLock(decodeBundleJSON(previous ?? await readBundleFile(directory, LOCK_FILE, LOCK_BYTES, signal)), config);
    const change: ProjectLockChange = { updated: previous === undefined, to: projectLockIdentity(lock) };
    return { lock, commit: () => Promise.resolve(change) };
  }
  const lock = createProjectLock(config), to = projectLockIdentity(lock);
  const existing = previous === undefined ? undefined : compareProjectLock(decodeBundleJSON(previous), lock);
  return { lock, commit: async () => {
    if (existing !== undefined && existing.fields.length === 0) return { updated: false, to };
    await replaceLock(directory, lock, previous, signal);
    return existing === undefined ? { updated: true, to } : { updated: true, from: existing.locked, to };
  } };
}
