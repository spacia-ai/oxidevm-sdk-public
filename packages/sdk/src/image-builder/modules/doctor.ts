import { join } from "node:path";
import { classifyLicense } from "../../wasm/license.js";
import { getSDKRelease } from "../project.js";
import { readReleaseDirectory } from "./release.js";
import { renderHandles, type HandleSpec } from "./generate.js";
import { DECLARATION_FILE, LOCK_FILE, loadModulesProject, readVendoredRelease, type ModulesProject } from "./project.js";
import { parseModuleSource, type ModuleSource } from "../../wasm/declaration.js";
import { lockedEntry, type LockedSource } from "../../wasm/lock.js";
import { DEFAULT_GENERATED_FILE, STAGE_ROOT } from "./stage.js";
import { manifestMinApi } from "../../wasm/capabilities.js";
import { moduleReach } from "../../wasm/reach.js";
import { moduleCommandPath } from "../../runtime/module-command-names.js";
import { readProjectFile } from "./project-files.js";
import { VMError } from "../../runtime/errors.js";
import { posix, relative, dirname, sep, resolve } from "node:path";

function sameSource(declared: ModuleSource, locked: LockedSource): boolean {
  if (declared.kind === "file") return locked.kind === "file" && locked.path === declared.path;
  return locked.kind === "github" && locked.repository.toLowerCase() === `${declared.owner}/${declared.repo}`.toLowerCase() && locked.tag === declared.tag;
}

/**
 * The three records of an installed module - the declaration, the lock and the committed module.json - must say the same
 * thing. Each is edited by people or by tools, and a pull request could change one to hide what another says.
 */
function lockInconsistencies(project: ModulesProject, committed: Committed): string[] {
  const problems: string[] = [];
  for (const declaration of project.declaration.modules) {
    const entry = lockedEntry(project.lock, declaration.id);
    if (entry === undefined) continue;
    if (!sameSource(parseModuleSource(declaration.from), entry.source)) problems.push(`${declaration.id}: the declaration names ${declaration.from} but the lock pins ${formatLockedSource(entry.source)}`);
    const vendored = committed.get(declaration.id);
    // Only the committed copy the lock pins can vouch for the lock; another file is reported as such by the vendored check.
    if (vendored === undefined || vendored.sha256 !== entry.manifestSha256) continue;
    if (vendored.manifest.version !== entry.version) problems.push(`${declaration.id}: the lock says version ${entry.version} but module.json says ${vendored.manifest.version}`);
    if ([...vendored.manifest.requires.host].sort().join(",") !== [...entry.capabilities].sort().join(",")) problems.push(`${declaration.id}: the lock records capabilities (${entry.capabilities.join(", ")}) that differ from module.json (${vendored.manifest.requires.host.join(", ")})`);
  }
  return problems;
}

/** What the project commits as `modules/<id>/module.json`, read once so that every check judges the same bytes; absent when missing or invalid. */
type Committed = ReadonlyMap<string, Awaited<ReturnType<typeof readVendoredRelease>>>;

async function readCommitted(projectDir: string, ids: readonly string[]): Promise<Committed> {
  return new Map(await Promise.all(ids.map(async (id): Promise<[string, Awaited<ReturnType<typeof readVendoredRelease>>]> => [id, await readVendoredRelease(projectDir, id).catch(() => undefined)])));
}

/** The "hosting" note: what every module needs from the page, plus what the modules cost the runtime. */
function hostingNote(ids: readonly string[], committed: Committed): string {
  const needs: string[] = [];
  for (const id of ids) {
    const manifest = committed.get(id)?.manifest;
    if (manifest === undefined) continue;
    const browser = manifest.requires.browser ?? [], guest = manifest.requires.guest?.executables ?? [];
    const parts = [...browser.length === 0 ? [] : [`the browser features ${browser.join(", ")}`], ...guest.length === 0 ? [] : [`the programs ${guest.join(", ")} in the image`]];
    if (parts.length > 0) needs.push(`${id} needs ${parts.join(" and ")}`);
  }
  return `Modules start Userspace JS processes in the VM's module frame, so they need a Userspace VM, self-hosted or in the hosted runtime frame, on a cross-origin isolated page in Chromium or Firefox (WebKit and Safari refuse them). JS processes, worker threads, esbuild runs and native commands share one lane of at most 32 host commands.${needs.length === 0 ? "" : ` ${needs.join("; ")}. The doctor cannot see the browser or the image: a start that finds one missing exits with code 122 and names it.`}`;
}

/**
 * The "commands" note, or nothing when no module declares commands: the names each declares, a name more than one declares,
 * the PATH a terminal needs, and which image programs a name can take the place of, as far as the modules' own requirements
 * name them (the doctor cannot see the image).
 */
function commandsNote(ids: readonly string[], committed: Committed): string | undefined {
  const declared = ids.flatMap(id => {
    const commands = committed.get(id)?.manifest.commands;
    return commands === undefined ? [] : [{ id, commands }];
  });
  if (declared.length === 0) return undefined;
  const owners = new Map<string, string[]>();
  for (const { id, commands } of declared) for (const name of commands) owners.set(name, [...owners.get(name) ?? [], id]);
  const names = [...owners.keys()].sort();
  const shared = names.flatMap(name => {
    const owning = owners.get(name) ?? [];
    return owning.length < 2 ? [] : [`${name} is declared by more than one module (${owning.join(", ")}), so a VM can turn it on for only one of them at a time.`];
  });
  const required = ids.flatMap(id => (committed.get(id)?.manifest.requires.guest?.executables ?? []).map(path => ({ id, path })));
  // Another module's command at /usr/local/bin is not an image program, so requiring it shadows nothing.
  const shadowed = names.flatMap(name => required.filter(item => posix.basename(item.path) === name && item.path !== moduleCommandPath(name)).map(item => `${name} can take the place of ${item.path}, which ${item.id} requires.`));
  return [
    `${declared.map(({ id, commands }) => `${id} declares ${commands.join(", ")}`).join("; ")}.`,
    ...shared,
    "An application turns commands on per VM, and programs run them as /usr/local/bin/<name>: a terminal's PATH must list /usr/local/bin before /usr/bin, and a command then takes the place of an image program with the same name.",
    ...shadowed,
  ].join(" ");
}

/**
 * The "network" note, or nothing when no module reaches the network (engine ADR 0029): each module's reach, the hosts and
 * purpose it discloses (never enforced), and what an internet module needs from the application.
 */
function networkNote(ids: readonly string[], committed: Committed): string | undefined {
  const reaching = ids.flatMap(id => {
    const manifest = committed.get(id)?.manifest;
    if (manifest === undefined) return [];
    const reach = moduleReach(manifest.requires.host);
    return reach === "none" ? [] : [{ id, reach, network: manifest.network }];
  });
  if (reaching.length === 0) return undefined;
  const lines = reaching.map(({ id, reach, network }) => {
    const disclosed = [...network?.hosts === undefined ? [] : [`it contacts ${network.hosts.join(", ")} by default`], ...network?.purpose === undefined ? [] : [`purpose: ${network.purpose}`]];
    return `${id} reaches ${reach === "vm" ? "programs in this VM only" : "the internet through the VM's connection"}${disclosed.length === 0 ? "" : ` (${disclosed.join("; ")})`}.`;
  });
  if (reaching.some(({ reach }) => reach === "internet")) lines.push("A module reaches the internet only after the application connects the VM with vm.network.connect and the user allows it; until then its connections fail as local-only.");
  return lines.join(" ");
}

function formatLockedSource(source: LockedSource): string {
  return source.kind === "file" ? `file:${source.path}` : `github:${source.repository}@${source.tag}`;
}

export const DOCTOR_CHECKS = ["declaration", "lock", "vendored", "staged", "generated", "engine-api", "license", "commands", "network", "hosting"] as const;
export type WasmDoctorCheck = (typeof DOCTOR_CHECKS)[number];

export type WasmDoctorEntry =
  | { readonly check: WasmDoctorCheck; readonly status: "passed" }
  | { readonly check: WasmDoctorCheck; readonly status: "failed" | "note"; readonly message: string };

export interface WasmDoctorReport {
  readonly result: "passed" | "failed";
  readonly modules: readonly string[];
  readonly checks: readonly WasmDoctorEntry[];
}

export interface DoctorOptions {
  readonly generatedFile?: string;
  /** The Userspace API version to compare against; defaults to the engine release this SDK pins. */
  readonly engineApi?: number;
  readonly signal?: AbortSignal;
}

/**
 * Checks that a project's modules are consistent from intent to generated code, and says what the installed SDK and
 * browser must provide. Nothing is fetched or changed.
 */
export async function doctorModules(projectDir: string, options: DoctorOptions = {}): Promise<WasmDoctorReport> {
  const checks: WasmDoctorEntry[] = [];
  const pass = (check: WasmDoctorCheck): void => { checks.push({ check, status: "passed" }); };
  const fail = (check: WasmDoctorCheck, message: string): void => { checks.push({ check, status: "failed", message }); };
  const note = (check: WasmDoctorCheck, message: string): void => { checks.push({ check, status: "note", message }); };

  let project;
  try { project = await loadModulesProject(projectDir); } catch (error: unknown) {
    fail("declaration", `${DECLARATION_FILE} or ${LOCK_FILE} cannot be read: ${error instanceof Error ? error.message : "invalid"}`);
    return { result: "failed", modules: [], checks };
  }
  const ids = project.declaration.modules.map(entry => entry.id);
  pass("declaration");
  const declared = new Set(ids), locked = Object.keys(project.lock.modules);
  const missing = ids.filter(id => lockedEntry(project.lock, id) === undefined), extra = locked.filter(id => !declared.has(id));
  const committed = await readCommitted(projectDir, ids);
  const inconsistent = lockInconsistencies(project, committed);
  if (missing.length === 0 && extra.length === 0 && inconsistent.length > 0) fail("lock", `${inconsistent.join("; ")}; run "oxidevm wasm add" for the module again`);
  else if (missing.length > 0 || extra.length > 0) fail("lock", `${[...missing.map(id => `${id} is not locked`), ...extra.map(id => `${id} is locked but not declared`)].join("; ")}; run "oxidevm wasm add"`);
  else pass("lock");

  const problems: string[] = [];
  const specs: HandleSpec[] = [];
  const apiNeeded = new Map<string, number>();
  for (const id of ids) {
    const entry = lockedEntry(project.lock, id);
    if (entry === undefined) continue;
    const vendored = committed.get(id);
    if (vendored === undefined) problems.push(`modules/${id}/module.json is missing or invalid`);
    else if (vendored.sha256 !== entry.manifestSha256) problems.push(`modules/${id}/module.json differs from the lock`);
    // The lock's capabilities count even without a readable module.json; the manifest adds what the lock does not record, such as commands.
    apiNeeded.set(id, Math.max(manifestMinApi({ requires: { host: entry.capabilities } }), vendored === undefined ? 0 : manifestMinApi(vendored.manifest)));
    const staged = join(projectDir, STAGE_ROOT, id, entry.release);
    try {
      const read = await readReleaseDirectory(staged, options.signal, { servedCopies: true });
      if (read.id !== entry.release) problems.push(`${id} is staged with a different release`);
      else specs.push({ manifest: read.manifest, release: read.id, files: read.files, directory: relative(dirname(resolve(projectDir, options.generatedFile ?? DEFAULT_GENERATED_FILE)), staged).split(sep).join(posix.sep) });
    } catch (error: unknown) { problems.push(`${id} is not staged${error instanceof VMError ? ` (${error.message})` : ""}: run "oxidevm wasm stage"`); }
  }
  if (problems.some(problem => problem.startsWith("modules/"))) fail("vendored", problems.filter(problem => problem.startsWith("modules/")).join("; ")); else pass("vendored");
  const stagedProblems = problems.filter(problem => !problem.startsWith("modules/"));
  if (stagedProblems.length > 0) fail("staged", stagedProblems.join("; ")); else pass("staged");

  const generatedPath = resolve(projectDir, options.generatedFile ?? DEFAULT_GENERATED_FILE);
  const generated = await readProjectFile(generatedPath, 4 * 1024 ** 2).then(bytes => bytes === undefined ? undefined : new TextDecoder().decode(bytes)).catch(() => undefined);
  if (specs.length === ids.length && ids.length > 0) {
    if (generated === undefined) fail("generated", `${relative(projectDir, generatedPath)} is missing: run "oxidevm wasm stage"`);
    else if (generated !== renderHandles(specs)) fail("generated", `${relative(projectDir, generatedPath)} is out of date: run "oxidevm wasm stage"`);
    else pass("generated");
  } else if (ids.length === 0) pass("generated"); else fail("generated", "cannot be checked until every module is staged");

  const provided = options.engineApi ?? getSDKRelease().engine.identities.userspaceApi;
  const behind = [...apiNeeded].filter(([, needed]) => needed > provided);
  if (behind.length > 0) fail("engine-api", `${behind.map(([id, needed]) => `${id} needs Userspace API ${String(needed)}`).join(", ")}; this SDK provides ${String(provided)}. Update @oxidevm/sdk.`);
  else pass("engine-api");

  const copyleft: string[] = [];
  for (const id of ids) {
    const vendored = committed.get(id)?.manifest;
    if (vendored !== undefined && classifyLicense(vendored.license.spdx).copyleft) copyleft.push(`${id} (${vendored.license.spdx})${vendored.license.source === undefined ? " without a source link" : ""}`);
  }
  if (copyleft.length === 0) pass("license");
  else if (copyleft.some(item => item.endsWith("without a source link"))) fail("license", `copyleft without a source link: ${copyleft.join(", ")}`);
  else note("license", `copyleft modules: ${copyleft.join(", ")}. Ship their notices and offer their source with your application.`);

  const commands = commandsNote(ids, committed);
  if (commands === undefined) pass("commands"); else note("commands", commands);
  const network = networkNote(ids, committed);
  if (network === undefined) pass("network"); else note("network", network);
  note("hosting", hostingNote(ids, committed));
  return { result: checks.some(entry => entry.status === "failed") ? "failed" : "passed", modules: ids, checks };
}
