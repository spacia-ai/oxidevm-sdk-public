import { relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { VMError } from "@oxidevm/sdk";
import { BlobCache, buildModule, commitAdd, defaultModuleCacheDir, doctorModules, githubToken, inspectWasm, previewAdd, readImageTrust, stageProject, testModule } from "@oxidevm/sdk/image-builder";
import type { AddConsent, ResolveContext, WasmBuildResult } from "@oxidevm/sdk/image-builder";
import type { CLIInvocation } from "./arguments.js";
import type { CliReport } from "./contracts.js";
import type { CLIEnvironment } from "./run.js";
import { releasePlan } from "./wasm-release.js";
import { consentText } from "./wasm-text.js";
import { initializeModule } from "./wasm-templates.js";
import { pinnedStarterRelease } from "./starter-release.js";

export type WasmCLIInvocation = Extract<CLIInvocation, { command: "wasm add" | "wasm stage" | "wasm doctor" | "wasm inspect" | "wasm build" | "wasm release" | "wasm init" | "wasm test" }>;

/** A path as the person would type it: relative to where they ran the command when it is inside, absolute otherwise. */
function shown(base: string, path: string): string {
  const relation = relative(base, path);
  return relation === "" || relation === ".." || relation.startsWith(`..${sep}`) ? path : relation;
}

async function buildFor(invocation: Extract<WasmCLIInvocation, { command: "wasm build" | "wasm release" }>, io: CLIEnvironment, check: boolean): Promise<WasmBuildResult> {
  const built = await buildModule(resolve(io.directory, invocation.project), { check, signal: io.signal, ...(invocation.out === undefined ? {} : { out: invocation.out }), ...(invocation.module === undefined ? {} : { module: invocation.module }) });
  return built.directory === null ? built : { ...built, directory: shown(io.directory, built.directory) };
}

async function context(projectDir: string, invocation: { readonly offline?: boolean }, io: CLIEnvironment): Promise<ResolveContext> {
  return { projectDir, cache: new BlobCache(defaultModuleCacheDir(io.environment)), token: await githubToken(io.environment), offline: invocation.offline === true, signal: io.signal };
}

/** Asks for consent when the preview says it is needed: `--yes` answers for a person who has reviewed the module. */
async function consentFor(invocation: Extract<WasmCLIInvocation, { command: "wasm add" }>, preview: Awaited<ReturnType<typeof previewAdd>>, io: CLIEnvironment): Promise<AddConsent> {
  if (!preview.consent.required) return preview.consent.otherwise;
  if (invocation.yes) return "approved";
  if (io.confirm === undefined) throw new VMError("INVALID_ARGUMENT", `${preview.card.id} needs your consent (${preview.consent.reasons.join(", ")}). Run this command in a terminal to see what the module declares and confirm, or read the module.json of the release first and pass --yes.`, { reason: "wasm-consent-required" });
  io.stderr(consentText(preview));
  if (!await io.confirm("Install this module? [y/N] ")) throw new VMError("ABORTED", "the module was not installed");
  return "approved";
}

export async function runWasmCommand(invocation: WasmCLIInvocation, io: CLIEnvironment): Promise<CliReport> {
  const command = invocation.command;
  switch (command) {
    case "wasm inspect": {
      const file = resolve(io.directory, invocation.file);
      const report = await inspectWasm(new Uint8Array(await readFile(file)));
      return { schemaVersion: 2, kind: "result", command, result: { file: invocation.file, ...report } };
    }
    case "wasm build": return { schemaVersion: 2, kind: "result", command, result: await buildFor(invocation, io, invocation.check) };
    case "wasm release": {
      const build = await buildFor(invocation, io, false);
      return { schemaVersion: 2, kind: "result", command, result: { build, ...releasePlan(build, { directory: build.directory ?? "dist", ...(invocation.repo === undefined ? {} : { repo: invocation.repo }) }) } };
    }
    case "wasm init": return { schemaVersion: 2, kind: "result", command, result: await initializeModule(resolve(io.directory, invocation.directory), { kind: invocation.moduleKind, ...(invocation.id === undefined ? {} : { id: invocation.id }), ...(invocation.from === undefined ? {} : { from: resolve(io.directory, invocation.from) }) }) };
    case "wasm test": {
      const projectDir = resolve(io.directory, invocation.project);
      const module = resolve(projectDir, invocation.module ?? "dist");
      // Without --image: the public starter image `oxidevm init` uses, which the page loads from the CDN.
      const image = invocation.image === undefined ? pinnedStarterRelease()?.image
        : { bundle: resolve(io.directory, invocation.image.bundle), trust: await readImageTrust(resolve(io.directory, invocation.image.trust)) };
      if (image === undefined) throw new VMError("INVALID_ARGUMENT", "this CLI pins no public starter image; pass --image <bundle> --image-trust <A.public.json>", { reason: "wasm-test-image" });
      const report = await testModule(module, { image, args: invocation.args, options: invocation.options, browser: invocation.browser, signal: io.signal,
        ...(invocation.engineDir === undefined ? {} : { engineDir: resolve(io.directory, invocation.engineDir) }), ...(invocation.timeoutMs === undefined ? {} : { commandMs: invocation.timeoutMs }) });
      return { schemaVersion: 2, kind: "result", command, result: report };
    }
    case "wasm doctor": return { schemaVersion: 2, kind: "result", command, result: await doctorModules(resolve(io.directory, invocation.project), { signal: io.signal }) };
    case "wasm stage": {
      const projectDir = resolve(io.directory, invocation.project);
      const result = await stageProject(projectDir, await context(projectDir, invocation, io));
      return { schemaVersion: 2, kind: "result", command, result: { modules: result.staged.map(entry => ({ id: entry.id, release: entry.release, rebuilt: entry.rebuilt })), vendored: result.vendored, removed: result.removed, generatedFile: invocation.project === "." ? result.generatedFile.replace(`${projectDir}/`, "") : result.generatedFile } };
    }
    case "wasm add": {
      const projectDir = resolve(io.directory, invocation.project), base = await context(projectDir, invocation, io);
      const preview = await previewAdd(projectDir, invocation.source, base);
      const consent = await consentFor(invocation, preview, io);
      const added = await commitAdd(projectDir, preview, base);
      const { card } = preview;
      return { schemaVersion: 2, kind: "result", command, result: {
        id: card.id, version: card.version, source: card.source, release: card.release, status: added.status, consent,
        license: { spdx: card.license.spdx, copyleft: card.license.copyleft }, capabilities: card.capabilities, added: preview.added, removed: preview.removed,
        generatedFile: added.stage.generatedFile.replace(`${projectDir}/`, ""),
      } };
    }
  }
}
