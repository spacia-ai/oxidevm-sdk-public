import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { integer, record } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import type { ImageRecipe } from "./contracts.js";
import { decodeBundleJSON, readBundleFile } from "./bundle-files.js";
import { decodeBuildkitInputFacts } from "./buildkit-inputs.js";
import type { BuildkitInputFacts } from "./buildkit-inputs.js";
import { abortIfRequested } from "./tools.js";

/** One active build owns an author's mutable input lock, including independent reproductions. */
export async function withAuthorBuild<T>(directory: string, signal: AbortSignal | undefined, build: () => Promise<T>): Promise<T> {
  abortIfRequested(signal); const path = join(directory, ".oxidevm-image-build.lock");
  const file = await open(path, "wx", 0o600).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new VMError("STORAGE_ERROR", "the recipe directory already has an active image build");
    throw error;
  });
  const identity = await file.stat();
  try {
    await file.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`); await file.sync();
    abortIfRequested(signal); return await build();
  } finally {
    await file.close();
    const current = await lstat(path).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current?.dev === identity.dev && current.ino === identity.ino) await rm(path);
  }
}

/** The author-side lock exists before the first tool runs and survives failed builds. */
export async function lockBuildEpoch(recipe: ImageRecipe, directory: string): Promise<ImageRecipe & { readonly sourceDateEpoch: number }> {
  const path = join(directory, "image.lock.json");
  let previous: Readonly<Record<string, unknown>> | undefined;
  try { previous = record(decodeBundleJSON(await readBundleFile(directory, "image.lock.json", 1024 ** 2)), "image inputs lock"); }
  catch (error) {
    // readBundleFile intentionally masks filesystem errors, so probe absence without following links.
    const missing = await open(path, "wx", 0o600).catch((cause: unknown) => {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST") throw error;
      throw cause;
    });
    const sourceDateEpoch = recipe.sourceDateEpoch ?? 0;
    try { await missing.writeFile(`${JSON.stringify({ schemaVersion: 2, kind: "build-inputs", mode: recipe.mode, id: recipe.id, version: recipe.version, sourceDateEpoch }, null, 2)}\n`); await missing.sync(); }
    finally { await missing.close(); }
    return { ...recipe, sourceDateEpoch };
  }
  if (previous["schemaVersion"] !== 2 || previous["mode"] !== recipe.mode || previous["id"] !== recipe.id) {
    throw new VMError("INVALID_ARGUMENT", "image.lock.json belongs to another recipe; give each recipe its own directory");
  }
  if (previous["version"] !== recipe.version) {
    // The same recipe at a new version: the lock pins the earlier version's inputs on purpose.
    const lockedVersion = typeof previous["version"] === "string" ? previous["version"].slice(0, 128) : "unknown";
    throw new VMError("INVALID_ARGUMENT", `image.lock.json locks version ${lockedVersion} of ${recipe.id}, but the recipe asks for ${recipe.version}; delete image.lock.json to lock the new version`, { lockedVersion, version: recipe.version });
  }
  const sourceDateEpoch = recipe.sourceDateEpoch ?? integer(previous["sourceDateEpoch"], "locked sourceDateEpoch", 0);
  return { ...recipe, sourceDateEpoch };
}

export async function saveAuthorLock(directory: string, bytes: string): Promise<void> {
  const temporary = join(directory, `.image-lock-${randomUUID()}`);
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, join(directory, "image.lock.json")); }
  finally { await rm(temporary, { force: true }); }
}

export async function previousDockerfileInputs(directory: string): Promise<BuildkitInputFacts | undefined> {
  const lock = record(decodeBundleJSON(await readBundleFile(directory, "image.lock.json", 1024 ** 2)), "author image lock");
  return lock["buildInputs"] === undefined || record(lock["buildInputs"], "build inputs")["kind"] !== "dockerfile" ? undefined : decodeBuildkitInputFacts(lock["buildInputs"]);
}

export function imageManifestURL(id: string, digest: string, configured?: string | URL): string {
  return `${configured === undefined ? `/oxidevm/images/${id}/${digest}/` : String(configured)}manifest.json`;
}
