import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { VMError } from "../../runtime/errors.js";
import { MANIFEST_INVALID } from "../../wasm/decode-support.js";
import { atomicBundle } from "../atomic.js";
import { abortIfRequested } from "../tools.js";
import { materialize } from "./cache.js";
import { GENERATED_MARKER, renderHandles, type HandleSpec } from "./generate.js";
import { readProjectFile, refuseLinks } from "./project-files.js";
import { readReleaseDirectory, servedName, type VerifiedRelease } from "./release.js";

/** Where staged bytes go, relative to the project; the directory is rebuilt by `oxidevm wasm stage` and not committed. */
export const STAGE_ROOT = ".oxidevm/modules";
/** The committed copy of each module's `module.json`, so a pull request shows what a module asks for. */
export const VENDOR_ROOT = "modules";
export const DEFAULT_GENERATED_FILE = "src/oxidevm.modules.generated.ts";
/** The most a file at the generated path may hold before it is certainly not ours; the real one is a few kilobytes. */
const MAX_GENERATED_BYTES = 4 * 1024 ** 2;

/** A module to stage: its verified release and where each file can be read from. */
export interface StageInput {
  readonly release: VerifiedRelease;
  readonly paths: ReadonlyMap<string, string>;
}

export interface StageOptions {
  readonly projectDir: string;
  readonly generatedFile?: string;
  readonly signal?: AbortSignal;
}

export interface StageResult {
  readonly staged: readonly { readonly id: string; readonly release: string; readonly directory: string; readonly rebuilt: boolean }[];
  readonly vendored: readonly string[];
  readonly generatedFile: string;
  readonly removed: readonly string[];
}

/** A run killed between writing a temporary file and renaming it leaves `<name>.<uuid>.tmp` behind; one that old is nobody's work in progress. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const ORPHAN_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

async function sweepOrphans(path: string): Promise<void> {
  const prefix = `${basename(path)}.`;
  for (const name of await readdir(dirname(path)).catch(() => [])) {
    if (!name.startsWith(prefix) || !ORPHAN_SUFFIX.test(name.slice(prefix.length))) continue;
    const orphan = join(dirname(path), name), metadata = await lstat(orphan).catch(() => undefined);
    if (metadata?.isFile() === true && Date.now() - metadata.mtimeMs > ORPHAN_AGE_MS) await rm(orphan, { force: true });
  }
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<boolean> {
  await sweepOrphans(path);
  // An existing file that is a link, too large or unreadable is simply replaced; only a byte-identical one is left alone.
  const current = await readProjectFile(path, bytes.byteLength).catch(() => undefined);
  if (current !== undefined && Buffer.compare(current, bytes) === 0) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
  return true;
}

/** True when `directory` already holds exactly this release: nothing to rebuild. */
async function alreadyStaged(directory: string, release: VerifiedRelease, signal?: AbortSignal): Promise<boolean> {
  try { return (await readReleaseDirectory(directory, signal, { servedCopies: true })).id === release.id; } catch { return false; }
}

async function stageRelease(directory: string, input: StageInput, signal?: AbortSignal): Promise<boolean> {
  if (await alreadyStaged(directory, input.release, signal)) return false;
  await atomicBundle(directory, async staging => {
    for (const file of input.release.files) {
      const source = input.paths.get(file.name);
      if (source === undefined) throw new VMError("INVALID_ARGUMENT", `no verified source for ${file.name}`, { reason: MANIFEST_INVALID });
      await materialize(source, join(staging, file.name));
      const served = servedName(file.name);
      if (served !== file.name) await materialize(source, join(staging, served));
    }
    await writeFile(join(staging, "module.json"), input.release.manifestBytes);
    await writeFile(join(staging, "SHA256SUMS"), input.release.sumsBytes);
    abortIfRequested(signal);
    const verified = await readReleaseDirectory(staging, signal, { servedCopies: true });
    if (verified.id !== input.release.id) throw new VMError("PROTOCOL_ERROR", "the staged release differs from the verified one", { reason: MANIFEST_INVALID });
  }, signal);
  return true;
}

/** What this tool names the directories it creates: a module id, and a release id (the sha256 of its SHA256SUMS). */
const MODULE_DIRECTORY = /^[a-z][a-z0-9-]{0,62}$/u;
const RELEASE_DIRECTORY = /^[0-9a-f]{64}$/u;

/**
 * Releases of this module other than `keep`, and modules that are no longer installed, are staged leftovers. Only real
 * directories named the way this tool names them are ever removed; a file, a link, or a directory of another name is
 * someone else's and stays.
 */
async function removeStale(root: string, keep: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<readonly string[]> {
  const removed: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    abortIfRequested(signal);
    if (!entry.isDirectory() || !MODULE_DIRECTORY.test(entry.name)) continue;
    const wanted = keep.get(entry.name);
    if (wanted === undefined) { await rm(join(root, entry.name), { recursive: true, force: true }); removed.push(entry.name); continue; }
    for (const release of await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => [])) {
      if (release.isDirectory() && RELEASE_DIRECTORY.test(release.name) && release.name !== wanted) { await rm(join(root, entry.name, release.name), { recursive: true, force: true }); removed.push(`${entry.name}/${release.name}`); }
    }
  }
  return removed;
}

/** Staging never writes or deletes through a link. */
const noLinks = (project: string, relativePath: string): Promise<void> => refuseLinks(project, relativePath, "oxidevm wasm never writes or deletes through links, so replace the link with a real directory");

/**
 * Makes the project match its lock: every module's verified files in `.oxidevm/modules/<id>/<release>/` (rebuilt
 * atomically only when missing or different), a committed copy of each `module.json`, and the generated handles file.
 * A generated file that does not carry the marker is never overwritten.
 */
export async function stageModules(inputs: ReadonlyMap<string, StageInput>, options: StageOptions): Promise<StageResult> {
  // The project directory is the caller's own choice and may be reached through a link; links inside it are refused below.
  const project = await realpath(resolve(options.projectDir));
  const generatedFile = resolve(project, options.generatedFile ?? DEFAULT_GENERATED_FILE);
  if (relative(project, generatedFile).startsWith("..")) throw new VMError("INVALID_ARGUMENT", "the generated file must be inside the project", { reason: MANIFEST_INVALID });
  const stageRoot = join(project, STAGE_ROOT);
  const ordered = [...inputs].sort(([left], [right]) => left < right ? -1 : 1);
  for (const [id, input] of ordered) {
    if (input.release.manifest.id !== id) throw new VMError("INVALID_ARGUMENT", `module ${id} is declared but its release is ${input.release.manifest.id}`, { reason: MANIFEST_INVALID });
  }
  // The handles are rendered before anything is written, so a release whose names collide (two ids that become one
  // JavaScript name, say) is refused while the project is still untouched.
  const specs: HandleSpec[] = ordered.map(([id, input]) => ({
    manifest: input.release.manifest, release: input.release.id, files: input.release.files,
    directory: relative(dirname(generatedFile), join(stageRoot, id, input.release.id)).split(sep).join(posix.sep),
  }));
  const handles = new TextEncoder().encode(renderHandles(specs));
  // Every place that will be read, written or cleaned is checked before the first of them is touched.
  await noLinks(project, STAGE_ROOT);
  await noLinks(project, VENDOR_ROOT);
  await noLinks(project, relative(project, generatedFile));
  for (const [id, input] of inputs) {
    await noLinks(project, join(STAGE_ROOT, id, input.release.id));
    await noLinks(project, join(VENDOR_ROOT, id, "module.json"));
  }
  const existing = await readProjectFile(generatedFile, MAX_GENERATED_BYTES, relative(project, generatedFile)).then(bytes => bytes === undefined ? undefined : new TextDecoder().decode(bytes));
  if (existing !== undefined && !existing.startsWith(GENERATED_MARKER)) throw new VMError("INVALID_ARGUMENT", `${relative(project, generatedFile)} exists and was not generated by oxidevm; move it or choose another file`, { reason: MANIFEST_INVALID });
  const staged: { id: string; release: string; directory: string; rebuilt: boolean }[] = [];
  const vendored: string[] = [];
  for (const [id, input] of ordered) {
    abortIfRequested(options.signal);
    const directory = join(stageRoot, id, input.release.id);
    const rebuilt = await stageRelease(directory, input, options.signal);
    staged.push({ id, release: input.release.id, directory, rebuilt });
    if (await writeAtomically(join(project, VENDOR_ROOT, id, "module.json"), input.release.manifestBytes)) vendored.push(id);
  }
  const removed = await removeStale(stageRoot, new Map(staged.map(entry => [entry.id, entry.release])), options.signal);
  await writeAtomically(generatedFile, handles);
  return { staged, vendored, generatedFile, removed };
}
