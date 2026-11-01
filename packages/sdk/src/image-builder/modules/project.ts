import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { VMError } from "../../runtime/errors.js";
import { decodeModulesDeclarationBytes, encodeModulesDeclaration, isTrustedSource, MAX_DECLARATION_BYTES, parseModuleSource, type ModuleSource, type ModulesDeclaration } from "../../wasm/declaration.js";
import { MANIFEST_INVALID } from "../../wasm/decode-support.js";
import { classifyLicense } from "../../wasm/license.js";
import { decodeModulesLockBytes, encodeModulesLock, lockedEntry, MAX_LOCK_BYTES, type ModulesLock } from "../../wasm/lock.js";
import { decodeModuleManifest, MAX_MANIFEST_BYTES } from "../../wasm/manifest.js";
import type { ResolvedManifest } from "../../wasm/manifest-types.js";
import { abortIfRequested } from "../tools.js";
import { authorityChange, consentCard, type ConsentCard } from "./consent.js";
import { moduleIdentifier } from "./generate.js";
import { sha256Hex } from "./sums.js";
import { readProjectFile } from "./project-files.js";
import { lockedModule, resolveLocked, resolveSource, type Resolution, type ResolveContext } from "./resolve.js";
import { stageModules, VENDOR_ROOT, type StageInput, type StageOptions, type StageResult } from "./stage.js";

export const DECLARATION_FILE = "oxidevm.modules.json";
export const LOCK_FILE = "oxidevm.modules.lock.json";

export interface ModulesProject {
  readonly declaration: ModulesDeclaration;
  readonly lock: ModulesLock;
}


async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

/** The two files of a project, or empty ones when it has no modules yet. */
export async function loadModulesProject(projectDir: string): Promise<ModulesProject> {
  const declarationBytes = await readProjectFile(join(projectDir, DECLARATION_FILE), MAX_DECLARATION_BYTES, DECLARATION_FILE), lockBytes = await readProjectFile(join(projectDir, LOCK_FILE), MAX_LOCK_BYTES, LOCK_FILE);
  return {
    declaration: declarationBytes === undefined ? { schemaVersion: 1, trusted: [], modules: [] } : decodeModulesDeclarationBytes(declarationBytes),
    lock: lockBytes === undefined ? { schemaVersion: 1, modules: {} } : decodeModulesLockBytes(lockBytes),
  };
}

/** The `module.json` committed under `modules/<id>/`, which is what the person last consented to, with the digest of its bytes. */
export async function readVendoredRelease(projectDir: string, id: string): Promise<{ readonly manifest: ResolvedManifest; readonly sha256: string } | undefined> {
  const bytes = await readProjectFile(join(projectDir, VENDOR_ROOT, id, "module.json"), MAX_MANIFEST_BYTES, `${VENDOR_ROOT}/${id}/module.json`);
  return bytes === undefined ? undefined : { manifest: decodeModuleManifest(bytes), sha256: sha256Hex(bytes) };
}

export async function readVendoredManifest(projectDir: string, id: string): Promise<ResolvedManifest | undefined> {
  return (await readVendoredRelease(projectDir, id))?.manifest;
}

export type ConsentReason = "untrusted-source" | "authority-widened";

/** Everything known about an add before anything is written: what it asks for, what would change, and whether to ask. */
export interface AddPreview {
  readonly card: ConsentCard;
  readonly status: "added" | "updated" | "unchanged";
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** When agreement is not required, `otherwise` says why: a trusted source, or nothing new being asked. */
  readonly consent: { readonly required: boolean; readonly reasons: readonly ConsentReason[]; readonly otherwise: "trusted-source" | "none-needed" };
  readonly resolution: Resolution;
  readonly source: ModuleSource;
}

/** Finds and verifies the release, compares it with what is installed and decides whether the person must be asked. Writes nothing. */
export async function previewAdd(projectDir: string, sourceText: string, context: ResolveContext): Promise<AddPreview> {
  const source = parseModuleSource(sourceText);
  const project = await loadModulesProject(projectDir);
  const resolution = await resolveSource(source, context);
  const { manifest } = resolution.release;
  // Refused before anyone is asked, not after they agreed: a copyleft release must say where its source is, and the id must
  // become a JavaScript name the generated handles can export.
  if (classifyLicense(manifest.license.spdx).copyleft && manifest.license.source === undefined) {
    throw new VMError("INVALID_ARGUMENT", `${manifest.id} declares the copyleft licence ${manifest.license.spdx} but names no license.source`, { reason: MANIFEST_INVALID });
  }
  moduleIdentifier(manifest.id);
  const installed = lockedEntry(project.lock, manifest.id);
  // The committed copy is the baseline only when it is the file the lock pins: an edited copy that already asks for more is no
  // evidence of what the person agreed to, so then everything the release asks for counts as new.
  const vendored = installed === undefined ? undefined : await readVendoredRelease(projectDir, manifest.id);
  const previous = vendored !== undefined && installed !== undefined && vendored.sha256 === installed.manifestSha256 ? vendored.manifest : undefined;
  const change = authorityChange(previous, manifest);
  const sameRelease = installed !== undefined && installed.release === resolution.release.id && JSON.stringify(installed.source) === JSON.stringify(resolution.source);
  const reasons: ConsentReason[] = [];
  // A different publisher under the same id is a new module as far as trust goes, whatever it asks for.
  const publisherChanged = installed !== undefined && (installed.source.kind !== resolution.source.kind || (installed.source.kind === "github" && resolution.source.kind === "github" && installed.source.repository.toLowerCase() !== resolution.source.repository.toLowerCase()));
  if ((installed === undefined || publisherChanged) && !isTrustedSource(project.declaration.trusted, source)) reasons.push("untrusted-source");
  // Authority is widened when the release asks for something the baseline did not, or when there is no baseline to compare with.
  if (installed !== undefined && (change.added.length > 0 || (previous === undefined && !sameRelease))) reasons.push("authority-widened");
  return {
    card: consentCard(resolution, source), status: installed === undefined ? "added" : sameRelease ? "unchanged" : "updated",
    added: change.added, removed: change.removed, resolution, source,
    consent: { required: reasons.length > 0, reasons, otherwise: installed === undefined && isTrustedSource(project.declaration.trusted, source) ? "trusted-source" : "none-needed" },
  };
}

export interface AddResult {
  readonly id: string;
  readonly status: AddPreview["status"];
  readonly stage: StageResult;
}

/**
 * Records an approved add. The files are staged first, from the lock and declaration the add would produce, and only a
 * project that staged is recorded: the declaration and lock are written last, so a release that cannot be staged (a name
 * that collides, a generated file that is not ours) leaves the project exactly as it was instead of poisoning every later stage.
 */
export async function commitAdd(projectDir: string, preview: AddPreview, context: ResolveContext, options: Pick<StageOptions, "generatedFile"> = {}): Promise<AddResult> {
  abortIfRequested(context.signal);
  const project = await loadModulesProject(projectDir);
  const id = preview.resolution.release.manifest.id;
  const lock: ModulesLock = { schemaVersion: 1, modules: { ...project.lock.modules, [id]: lockedModule(preview.resolution) } };
  const declaration: ModulesDeclaration = { ...project.declaration, modules: [...project.declaration.modules.filter(entry => entry.id !== id), { id, from: preview.card.source }] };
  const stage = await stageState(projectDir, { declaration, lock }, context, options, new Map([[id, { release: preview.resolution.release, paths: preview.resolution.paths }]]));
  await writeAtomically(join(projectDir, LOCK_FILE), encodeModulesLock(lock));
  await writeAtomically(join(projectDir, DECLARATION_FILE), encodeModulesDeclaration(declaration));
  return { id, status: preview.status, stage };
}

/** Makes the staged files and generated handles match the lock, fetching only what the cache lacks. */
export async function stageProject(projectDir: string, context: ResolveContext, options: Pick<StageOptions, "generatedFile"> = {}): Promise<StageResult> {
  return stageState(projectDir, await loadModulesProject(projectDir), context, options);
}

/** Stages the modules a declaration and lock describe; `resolved` holds releases that are already in hand and need no lookup. */
async function stageState(projectDir: string, state: ModulesProject, context: ResolveContext, options: Pick<StageOptions, "generatedFile">, resolved: ReadonlyMap<string, StageInput> = new Map()): Promise<StageResult> {
  const declared = new Set(state.declaration.modules.map(entry => entry.id)), locked = new Set(Object.keys(state.lock.modules));
  for (const id of declared) if (!locked.has(id)) throw new VMError("INVALID_ARGUMENT", `${id} is declared in ${DECLARATION_FILE} but not locked: run "oxidevm wasm add" for it`, { reason: MANIFEST_INVALID });
  for (const id of locked) if (!declared.has(id)) throw new VMError("INVALID_ARGUMENT", `${id} is locked but not declared in ${DECLARATION_FILE}: remove it from the lock or declare it`, { reason: MANIFEST_INVALID });
  const inputs = new Map<string, StageInput>();
  for (const [id, entry] of Object.entries(state.lock.modules)) {
    const known = resolved.get(id);
    if (known !== undefined) { inputs.set(id, known); continue; }
    const resolution = await resolveLocked(entry, { ...context, projectDir: resolve(projectDir) });
    inputs.set(id, { release: resolution.release, paths: resolution.paths });
  }
  return stageModules(inputs, { projectDir, ...(context.signal === undefined ? {} : { signal: context.signal }), ...options });
}
