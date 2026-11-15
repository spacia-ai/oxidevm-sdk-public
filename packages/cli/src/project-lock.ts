import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VMError } from "@oxvm/sdk";
import { getSDKRelease } from "@oxvm/sdk/image-builder";
import type { ProjectLockChange, ProjectLockIdentity } from "@oxvm/sdk/image-builder";
import { object } from "./validation.js";

const MANIFEST_BYTES = 64 * 1024;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

/** The versions `--update-lock` binds: this CLI, the SDK it runs and the SDK the project resolves (null when none). */
export interface LockVersions { readonly cli: string; readonly runtime: string; readonly project: string | null }

/** Why `--update-lock` cannot write one release into the lock, or undefined when all three versions agree. */
export function versionRefusal({ cli, runtime, project }: LockVersions): string | undefined {
  if (project === cli && runtime === cli) return undefined;
  const sdk = project === null ? "no @oxvm/sdk installed beside" : `@oxvm/sdk ${project} and`;
  const runs = runtime === cli ? "" : `, which runs @oxvm/sdk ${runtime}`;
  return `--update-lock writes the lock for one release, but this project has ${sdk} @oxvm/cli ${cli}${runs}; install both at the same version, then run \`npx oxvm assets install --update-lock\` again`;
}

function manifestVersion(bytes: Buffer, name: string): string | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new VMError("PROTOCOL_ERROR", `${name} package manifest is not JSON`); }
  const manifest = object(value, `${name} package manifest`), version = manifest["version"];
  if (manifest["name"] !== name) throw new VMError("INVALID_ARGUMENT", `${name} resolves to a different package; install a matching @oxvm/sdk and @oxvm/cli pair before updating its lock`);
  if (typeof version !== "string" || !VERSION.test(version)) throw new VMError("PROTOCOL_ERROR", `${name} package manifest has an invalid version`);
  return version;
}

/** The version in a package manifest named `name`; null when the file is absent. */
async function packageVersion(path: string | URL, name: string): Promise<string | null> {
  let file: FileHandle;
  try { file = await open(path, "r"); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
  try {
    if ((await file.stat()).size > MANIFEST_BYTES) throw new VMError("PROTOCOL_ERROR", `${name} package manifest exceeds its limit`);
    return manifestVersion(await file.readFile(), name);
  } finally { await file.close(); }
}

/** The `@oxvm/sdk` the project's own code resolves: the nearest `node_modules` at or above its directory. */
async function projectSDKVersion(directory: string): Promise<string | null> {
  for (let current = resolve(directory); ; current = dirname(current)) {
    const version = await packageVersion(join(current, "node_modules", "@oxvm", "sdk", "package.json"), "@oxvm/sdk");
    const legacy = await packageVersion(join(current, "node_modules", "@oxidevm", "sdk", "package.json"), "@oxidevm/sdk");
    if (legacy !== null) throw new VMError("INVALID_ARGUMENT", "This project still installs @oxidevm/sdk; install a matching @oxvm/sdk and @oxvm/cli pair before updating its lock");
    if (version !== null || dirname(current) === current) return version;
  }
}

/** A lock written by this CLI is true only when the project builds with the same SDK release. */
export async function requireOneRelease(projectDirectory: string): Promise<void> {
  const cli = await packageVersion(new URL("../package.json", import.meta.url), "@oxvm/cli");
  if (cli === null) throw new VMError("PROTOCOL_ERROR", "the @oxvm/cli package manifest is missing");
  const refusal = versionRefusal({ cli, runtime: getSDKRelease().sdkVersion, project: await projectSDKVersion(projectDirectory) });
  if (refusal !== undefined) throw new VMError("INVALID_ARGUMENT", refusal);
}

/** What `assets install` did to the project lock, old → new, for stderr; nothing when it neither wrote nor was asked to. */
export function lockChangeText(change: ProjectLockChange, requested: boolean): string {
  const release = (lock: ProjectLockIdentity) => ({ SDK: lock.sdkVersion, engine: lock.engineRelease, image: `sha256:${lock.manifestSHA256}` });
  const to = release(change.to);
  if (!change.updated) return requested ? `The project lock already matches this SDK release (SDK ${to.SDK}, engine ${to.engine}, image ${to.image}); nothing to rewrite\n` : "";
  const from = change.from === undefined ? undefined : release(change.from);
  const rows = (["SDK", "engine", "image"] as const).map(field => {
    const next = to[field], previous = from?.[field];
    return `  ${field.padEnd(8)}${previous === undefined ? next : previous === next ? `${next} (unchanged)` : `${previous} → ${next}`}\n`;
  });
  return `${from === undefined ? "Wrote" : "Updated"} the project lock for this SDK release:\n${rows.join("")}`;
}
