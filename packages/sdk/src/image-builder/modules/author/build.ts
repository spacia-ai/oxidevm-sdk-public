import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyLicense } from "../../../wasm/license.js";
import { MAX_ARTIFACT_BYTES } from "../../../wasm/manifest-parts.js";
import { decodeResolvedManifest, encodeModuleManifest } from "../../../wasm/manifest.js";
import type { ArtifactDecl, ModuleDecl } from "../../../wasm/manifest-types.js";
import { copyVerified, hashFile } from "../../files.js";
import { abortIfRequested } from "../../tools.js";
import { verifyRelease } from "../release.js";
import type { Measured } from "../release.js";
import { formatSums, sha256Hex } from "../sums.js";
import { bundleAdapter } from "./bundle.js";
import { packageNameOf } from "./bundle.js";
import type { Bundle, BundledPackage, StubbedImport } from "./bundle.js";
import { extractManifest, MAX_MODULE_SOURCE_BYTES } from "./extract.js";
import { BuildFailure, finding } from "./findings.js";
import type { Finding } from "./findings.js";
import { lintAdapter } from "./lint.js";

/** The largest adapter a release may ship; it is fetched whole and imported, so it stays modest. */
export const MAX_ADAPTER_BYTES = 16 * 1024 ** 2;
export const DEFAULT_MODULE_FILE = "module.ts";
export const DEFAULT_OUTPUT_DIRECTORY = "dist";

export interface BuildOptions {
  /** The module source, relative to the project; defaults to `module.ts`. */
  readonly module?: string;
  /** The release directory, inside the project; defaults to `dist`. */
  readonly out?: string;
  /** Verify everything and write nothing. */
  readonly check?: boolean;
  readonly signal?: AbortSignal;
}

export interface BuildResult {
  readonly result: "built" | "checked" | "failed";
  readonly id: string | null;
  readonly version: string | null;
  /** The release id: the sha256 of the canonical SHA256SUMS. */
  readonly release: string | null;
  /** Where the release was written; null when nothing was. */
  readonly directory: string | null;
  /** Every file of the release, `module.json` and `SHA256SUMS` included, sorted by name. */
  readonly files: readonly Measured[];
  readonly bundled: readonly BundledPackage[];
  readonly findings: readonly Finding[];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function realpathIfPresent(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readModuleSource(projectDir: string, modulePath: string): Promise<string> {
  const fail = (message: string): never => { throw new BuildFailure([finding("error", "module-source", message, { file: modulePath })]); };
  if (!/^(?!\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.m?ts$/u.test(modulePath) || modulePath.split("/").some(part => part === "..")) return fail(`the module file must be a relative .ts or .mts path inside the project, not ${JSON.stringify(modulePath)}`);
  const path = resolve(projectDir, modulePath);
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) return fail(`${modulePath} does not exist; a module project keeps its definition there (oxidevm wasm init creates one)`);
  if (!metadata.isFile()) return fail(`${modulePath} must be a regular file, not a link or directory`);
  if (metadata.size > MAX_MODULE_SOURCE_BYTES) return fail(`${modulePath} is larger than ${String(MAX_MODULE_SOURCE_BYTES)} bytes`);
  return readFile(path, "utf8");
}

interface MeasuredSource extends Measured {
  /** The absolute path the bytes were measured from. */
  readonly source: string;
}

/** Hashes every artifact the manifest names, collecting all problems instead of stopping at the first. */
async function measureArtifacts(projectDir: string, artifacts: readonly ArtifactDecl[], signal: AbortSignal | undefined): Promise<readonly MeasuredSource[]> {
  const root = await realpath(projectDir);
  const problems: Finding[] = [];
  const measured: MeasuredSource[] = [];
  for (const artifact of artifacts) {
    const from = artifact.from ?? "";
    const source = resolve(projectDir, from);
    const problem = (code: "artifact-missing" | "artifact-unsafe" | "artifact-size", message: string): void => { problems.push(finding("error", code, `artifact ${artifact.name}: ${message}`, { file: from })); };
    const parent = await realpathIfPresent(dirname(source));
    const metadata = parent === undefined ? undefined : await lstatIfPresent(source);
    if (parent === undefined || metadata === undefined) problem("artifact-missing", `${from} does not exist`);
    else if (parent !== root && !isInside(root, parent)) problem("artifact-unsafe", `${from} resolves outside the project through a symbolic link`);
    else if (metadata.isSymbolicLink() || !metadata.isFile()) problem("artifact-unsafe", `${from} must be a regular file, not a link or directory`);
    else if (metadata.size > MAX_ARTIFACT_BYTES) problem("artifact-size", `${from} is ${String(metadata.size)} bytes; the limit is ${String(MAX_ARTIFACT_BYTES)}`);
    else measured.push({ name: artifact.name, sha256: await hashFile(source, signal), bytes: metadata.size, source });
  }
  if (problems.length > 0) throw new BuildFailure(problems);
  return measured;
}

function stubbedFinding(stubbed: readonly StubbedImport[]): Finding {
  // One entry per specifier and package: several files of a package often import the same built-in.
  const labels = [...new Set(stubbed.map(item => `${item.specifier} (${packageNameOf(item.importer) ?? item.importer})`))];
  const shown = labels.slice(0, 10);
  const one = labels.length === 1;
  return finding("warning", "adapter-stubbed", `${String(labels.length)} import${one ? "" : "s"} in dependency code ${one ? "was" : "were"} replaced with ${one ? "an empty module" : "empty modules"}, because a worker cannot provide ${one ? "it" : "them"}: ${shown.join(", ")}${labels.length > shown.length ? ", ..." : ""}. ${one ? "It matters" : "They matter"} only if that code runs; test it.`);
}

function licenseFindings(declaration: ModuleDecl, packages: readonly BundledPackage[]): readonly Finding[] {
  const found: Finding[] = [];
  const own = classifyLicense(declaration.license.spdx);
  const sourceNote = "so license.source must say where its complete source is";
  if (own.copyleft && declaration.license.source === undefined) found.push(finding("error", "license-source", `the module's license (${declaration.license.spdx}) is copyleft, ${sourceNote}`));
  const unnamed: string[] = [];
  for (const entry of packages) {
    const label = `${entry.name}@${entry.version} (${entry.license})`;
    let classification;
    try { classification = classifyLicense(entry.license); } catch { unnamed.push(label); continue; }
    if (classification.copyleft && declaration.license.source === undefined) found.push(finding("error", "license-source", `the adapter bundles ${label}, which is copyleft, ${sourceNote}`));
    else if (classification.ids.some(id => !own.ids.includes(id))) unnamed.push(label);
  }
  if (unnamed.length > 0) found.push(finding("warning", "license-bundled", `the adapter bundles ${String(unnamed.length)} package(s) whose license license.spdx does not name or that declare none: ${unnamed.slice(0, 10).join(", ")}${unnamed.length > 10 ? ", ..." : ""}`));
  if (packages.length > 0 && (declaration.license.notices ?? []).length === 0) found.push(finding("warning", "notices-missing", `the adapter bundles ${String(packages.length)} third-party package(s); license.notices should name an artifact that carries their notices`));
  return found;
}

/** Refuses an output directory that could clobber the author's own files or something that is not a previous build. */
async function outputFindings(projectDir: string, out: string, readFrom: readonly string[]): Promise<readonly Finding[]> {
  const shown = relative(projectDir, out) || ".";
  const fail = (message: string): readonly Finding[] => [finding("error", "output-unsafe", message)];
  if (!isInside(projectDir, out)) return fail(`the output directory ${shown} must be inside the project and not the project itself`);
  const clobbered = readFrom.find(path => isInside(out, path));
  if (clobbered !== undefined) return fail(`the output directory ${shown} would contain ${relative(projectDir, clobbered)}, a file the build reads`);
  const metadata = await lstatIfPresent(out);
  if (metadata === undefined) return [];
  if (!metadata.isDirectory()) return fail(`${shown} exists and is not a directory (links are not followed)`);
  if ((await readdir(out)).length === 0) return [];
  const sums = await lstatIfPresent(join(out, "SHA256SUMS"));
  return sums?.isFile() === true ? [] : fail(`${shown} exists and is not an earlier build output (it has no SHA256SUMS); choose another --out or empty it`);
}

interface Assembled {
  readonly id: string;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  readonly sumsBytes: Uint8Array<ArrayBuffer>;
  readonly files: readonly Measured[];
}

function assemble(declaration: ModuleDecl, bundle: Bundle, artifacts: readonly MeasuredSource[]): Assembled {
  const adapter: Measured = { name: "adapter.mjs", sha256: sha256Hex(bundle.bytes), bytes: bundle.bytes.byteLength };
  const resolved = decodeResolvedManifest({
    ...declaration, schemaVersion: 1, adapter: { api: 1, sha256: adapter.sha256, bytes: adapter.bytes },
    artifacts: artifacts.map(artifact => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes })),
  });
  const manifestBytes = encodeModuleManifest(resolved);
  const measured: readonly Measured[] = [adapter, ...artifacts.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))];
  const sumsBytes = formatSums([{ name: "module.json", sha256: sha256Hex(manifestBytes) }, ...measured]);
  const verified = verifyRelease(manifestBytes, sumsBytes, measured);
  const files: Measured[] = [{ name: "module.json", sha256: sha256Hex(manifestBytes), bytes: manifestBytes.byteLength }, ...measured, { name: "SHA256SUMS", sha256: sha256Hex(sumsBytes), bytes: sumsBytes.byteLength }];
  return { id: verified.id, manifestBytes, sumsBytes, files: files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0) };
}

/** Writes the release beside `out` and swaps it in, so `out` is always either the old build or the complete new one. */
async function writeRelease(out: string, assembled: Assembled, bundle: Bundle, artifacts: readonly MeasuredSource[], signal: AbortSignal | undefined): Promise<"written"> {
  const staging = `${out}.building-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "module.json"), assembled.manifestBytes);
    await writeFile(join(staging, "adapter.mjs"), bundle.bytes);
    await writeFile(join(staging, "SHA256SUMS"), assembled.sumsBytes);
    for (const artifact of artifacts) await copyVerified(artifact.source, join(staging, artifact.name), artifact, signal);
    const replaced = await lstatIfPresent(out) === undefined ? undefined : `${out}.replaced-${randomUUID()}`;
    if (replaced !== undefined) await rename(out, replaced);
    await rename(staging, out);
    if (replaced !== undefined) await rm(replaced, { recursive: true, force: true });
    return "written";
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Builds a module project into a release: the manifest read from `module.ts`, the adapter bundled into
 * `adapter.mjs`, every artifact pinned, and a canonical `SHA256SUMS` whose digest names the release. Problems the
 * author can fix come back as located findings in a `failed` result; nothing is written unless every check passes.
 */
export async function buildModule(projectDir: string, options: BuildOptions = {}): Promise<BuildResult> {
  const root = resolve(projectDir);
  const modulePath = options.module ?? DEFAULT_MODULE_FILE;
  const findings: Finding[] = [];
  const attempt = async <T>(stage: () => Promise<T> | T): Promise<T | undefined> => {
    try { return await stage(); } catch (error) {
      if (error instanceof BuildFailure) { findings.push(...error.findings); return undefined; }
      throw error;
    }
  };
  const failed = (declaration?: ModuleDecl, bundled: readonly BundledPackage[] = []): BuildResult => ({ result: "failed", id: declaration?.id ?? null, version: declaration?.version ?? null, release: null, directory: null, files: [], bundled, findings });

  abortIfRequested(options.signal);
  const source = await attempt(() => readModuleSource(root, modulePath));
  const declaration = source === undefined ? undefined : await attempt(() => extractManifest(source, modulePath));
  if (declaration === undefined) return failed();
  const bundle = await attempt(() => bundleAdapter(root, modulePath, options.signal));
  if (bundle !== undefined) {
    const linted = await attempt(() => lintAdapter(bundle.text, bundle.locate));
    findings.push(...linted ?? []);
    if (bundle.stubbed.length > 0) findings.push(stubbedFinding(bundle.stubbed));
    if (bundle.bytes.byteLength > MAX_ADAPTER_BYTES) findings.push(finding("error", "adapter-size", `the adapter is ${String(bundle.bytes.byteLength)} bytes; the limit is ${String(MAX_ADAPTER_BYTES)}`));
    findings.push(...licenseFindings(declaration, bundle.packages));
  }
  const artifacts = await attempt(() => measureArtifacts(root, declaration.artifacts, options.signal));
  const out = resolve(root, options.out ?? DEFAULT_OUTPUT_DIRECTORY);
  if (options.check !== true) findings.push(...await outputFindings(root, out, [resolve(root, modulePath), ...(artifacts ?? []).map(artifact => artifact.source)]));
  if (bundle === undefined || artifacts === undefined || findings.some(item => item.severity === "error")) return failed(declaration, bundle?.packages);

  const assembled = assemble(declaration, bundle, artifacts);
  const common = { id: declaration.id, version: declaration.version, release: assembled.id, files: assembled.files, bundled: bundle.packages, findings };
  if (options.check === true) return { result: "checked", directory: null, ...common };
  const written = await attempt(() => writeRelease(out, assembled, bundle, artifacts, options.signal));
  return written === undefined ? failed(declaration, bundle.packages) : { result: "built", directory: out, ...common };
}
