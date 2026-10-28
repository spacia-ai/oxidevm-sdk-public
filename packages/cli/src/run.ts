import { dirname, resolve } from "node:path";
import { VMError } from "@oxidevm/sdk";
import { buildImage, downloadImageBundle, getSDKRelease, inspectImage, installProjectAssets, loadImageRecipe, loadImageReference, loadProjectConfig, generateImageKey, readImageTrust, testImage, doctorProject, packImage } from "@oxidevm/sdk/image-builder";
import { parseArguments } from "./arguments.js";
import type { CLIInvocation } from "./arguments.js";
import type { CliCommand, CliReport } from "./contracts.js";
import { decodeCliReport } from "./report.js";
import { initializeApplication, initializeImage } from "./templates.js";
import { startApplication } from "./start-application.js";
import { readStarterInputs } from "./starter-inputs.js";
import { pinnedStarterRelease } from "./starter-release.js";
import {runSnapshotCommand} from "./snapshot-commands.js";
import {snapshotHelp,snapshotCommandHelp} from "./snapshot-help.js";
import {snapshotFailureDetail,snapshotFailureText,cancellationExit} from "./snapshot-errors.js";

export interface CLIEnvironment {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  stdout(text: string): void;
  stderr(text: string): void;
}
const help = `oxidevm — Linux in your browser\n\nCommands:\n  init <directory> [--start] [--use-bun]\n    Creates the nginx starter using the hosted runtime and signed image.\n    Advanced: [--mode system|userspace] [--image <bundle> --image-trust <file>]\n              [--skip-assets | --engine-dir <release>] [--sdk-archive <sdk.tgz> --cli-archive <cli.tgz>]\n  assets install [--config oxidevm.config.ts] [--image <bundle> --trust <file>] [--reference <file>] [--engine-dir <release>]\n  doctor [url] [--browser chromium|firefox|webkit] [--preview-origin <origin>]\n  image init <directory> --mode system|userspace\n  image keygen --out <author.pem>\n  image build <recipe.ts> --signing-key <author.pem> [--distribution]\n  image test <bundle> --trust <author.public.json> [--browser chromium|firefox|webkit] [--engine-dir <release>]\n  image inspect <bundle> [--trust <author.public.json>]\n  image pack <bundle> --trust <author.public.json>\n\nEvery command accepts --json; --start runs interactively and cannot use --json. Paths resolve from the current directory.\nNormal init installs no local engine files. Development and production use run.oxidevm.dev.\nSelf-hosting is an explicit commercial option: --engine-dir selects a local pinned release.\nExplicit assets/image test commands can use OXIDEVM_ENGINE_DIR or the verified engine cache.\nExample: oxidevm init app --start\n`;

async function execute(invocation: CLIInvocation, io: CLIEnvironment): Promise<CliReport> {
  const path = (value: string) => resolve(io.directory, value); const command = invocation.command;
  switch (command) {
    case "snapshot init":case "snapshot build":case "snapshot pack":case "snapshot test":case "snapshot inspect":return runSnapshotCommand(invocation,io);
    case "init": {
      const starter = invocation.mode === "userspace" && invocation.image === undefined ? await readStarterInputs(io.directory, getSDKRelease().sdkVersion) : undefined;
      const release = invocation.mode === "userspace" && invocation.image === undefined ? pinnedStarterRelease() : undefined;
      if (invocation.mode === "userspace" && invocation.image === undefined && starter === undefined && release === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Run this private preview from its prepared launcher directory. Its prebuilt image and runtime are supplied automatically; no image build is needed.");
      const localImage = invocation.image === undefined ? starter?.image : { bundle: path(invocation.image.bundle), trust: path(invocation.image.trust) };
      const engineDir = invocation.engineDir === undefined ? starter?.engineDir : path(invocation.engineDir);
      const image = localImage === undefined
        ? engineDir === undefined || release === undefined ? undefined : { bundle: await downloadImageBundle(release.archive, release.image, { signal: io.signal }), trust: release.image.trust }
        : { bundle: localImage.bundle, trust: await readImageTrust(localImage.trust) };
      const archives = invocation.archives === undefined ? starter?.archives : { sdk: path(invocation.archives.sdk), cli: path(invocation.archives.cli) };
      const productionImage = release?.image;
      const engineComplianceDir = starter?.engineComplianceDir;
      return { schemaVersion: 2, kind: "result", command, result: await initializeApplication(path(invocation.directory), invocation.mode, invocation.skipAssets, io.signal, { ...(archives === undefined ? {} : { archives }), ...(engineDir === undefined ? {} : { engineDir }), ...(image === undefined ? {} : { image }), ...(productionImage === undefined ? {} : { productionImage }), ...(release === undefined ? {} : { materialsUrl: release.materialsUrl }), ...(engineComplianceDir === undefined ? {} : { engineComplianceDir }) }) };
    }
    case "assets install": {
      const project = await loadProjectConfig(path(invocation.config));
      return { schemaVersion: 2, kind: "result", command, result: await installProjectAssets(project.directory, project.config, { signal: io.signal, ...(invocation.image === undefined ? {} : { imageDir: path(invocation.image) }),...(invocation.snapshot===undefined?{}:{snapshotDir:path(invocation.snapshot)}),...(invocation.trust===undefined?{}:{trust:await readImageTrust(path(invocation.trust))}), ...(invocation.reference === undefined ? {} : { referencePath: path(invocation.reference) }), ...(invocation.engineDir === undefined ? {} : { engineDir: path(invocation.engineDir) }) }) };
    }
    case "doctor": return { schemaVersion: 2, kind: "result", command, result: await doctorProject(invocation.url, { browser: invocation.browser, signal: io.signal, ...(invocation.previewOrigin === undefined ? {} : { previewOrigin: invocation.previewOrigin }) }) };
    case "image init": return { schemaVersion: 2, kind: "result", command, result: await initializeImage(path(invocation.directory), invocation.mode) };
    case "image keygen": {
      const key = await generateImageKey(path(invocation.out));
      return { schemaVersion: 2, kind: "result", command, result: { privateKeyPath: key.privateKeyPath, publicKeyPath: key.publicKeyPath, keyId: key.trust.keyId } };
    }
    case "image build": {
      const loaded = await loadImageRecipe(path(invocation.recipe));
      const built = await buildImage(loaded, { recipeDir: dirname(path(invocation.recipe)), signingKeyFile: path(invocation.signingKey), signal: io.signal, purpose: invocation.distribution ? "distribution" : "development", secrets: invocation.secrets.map(secret => ({ id: secret.id, file: path(secret.file) })), ...(invocation.out === undefined ? {} : { outDir: path(invocation.out) }), ...(invocation.baseUrl === undefined ? {} : { publicBaseUrl: invocation.baseUrl }), onProgress: progress => { io.stderr(`${progress.phase}\n`); } });
      return { schemaVersion: 2, kind: "result", command, result: { mode: built.mode, manifestSHA256: built.image.manifestSHA256, bundleDir: built.bundleDir, referencePath: built.referencePath, lockPath: built.lockPath, distribution: built.distribution } };
    }
    case "image test": {
      const trust = await readImageTrust(path(invocation.trust)); const image = await loadImageReference(path(invocation.bundle), trust);
      return { schemaVersion: 2, kind: "result", command, result: await testImage(path(invocation.bundle), { image, browser: invocation.browser, purpose: invocation.distribution ? "distribution" : "development", signal: io.signal, ...(invocation.engineDir === undefined ? {} : { engineDir: path(invocation.engineDir) }) }) };
    }
    case "image inspect": return { schemaVersion: 2, kind: "result", command, result: await inspectImage(path(invocation.bundle), { signal: io.signal, ...(invocation.trust === undefined ? {} : { trust: await readImageTrust(path(invocation.trust)) }) }) };
    case "image pack": return { schemaVersion: 2, kind: "result", command, result: await packImage(path(invocation.bundle), { signal: io.signal, trust: await readImageTrust(path(invocation.trust)) }) };
  }
}

/** One boundary normalizes output and exit codes; resource-owning SDK operations perform cleanup. */
export async function runCLI(arguments_: readonly string[], io: CLIEnvironment): Promise<number> {
  const json = arguments_.includes("--json"); let command: CliCommand | null = null;
  try {
    const invocation = parseArguments(arguments_, io.environment);
    if (invocation.kind !== "command") {
      // Help and version are textual control flags, outside the eight-command JSON envelope.
      if (json) throw new VMError("INVALID_ARGUMENT", "use --help or --version without --json");
      const release = getSDKRelease();
      io.stdout(invocation.kind === "help" ? invocation.command===undefined?help+snapshotHelp:snapshotCommandHelp(invocation.command) : `@oxidevm/cli ${release.sdkVersion}; @oxidevm/sdk ${release.sdkVersion}; engine ${release.engineRelease}\n`); return 0;
    }
    command = invocation.command;
    if (io.signal.aborted) throw new VMError("ABORTED", "command interrupted");
    const report = decodeCliReport(await execute(invocation, io));
    io.stdout(json ? `${JSON.stringify(report)}\n` : successText(report));
    if (invocation.command === "init" && invocation.start && report.command === "init" && report.kind === "result") await startApplication(report.result.directory, invocation.packageManager, io);
    return report.kind === "result" && (report.command === "doctor" || report.command === "image test"||report.command==="snapshot test") && report.result.result === "failed" ? 3 : 0;
  } catch (error) {
    const interrupted = io.signal.aborted;
    const code = interrupted ? "ABORTED" : error instanceof VMError ? error.code : "STORAGE_ERROR";
    // Raw filesystem/tool errors can include author secrets. Emit only normalized SDK context.
    const snapshot=command?.startsWith("snapshot ")===true;
    const message = interrupted ? "command interrupted; owned resources have been cleaned up" : snapshot?"Snapshot command failed; check its phase and reason":error instanceof VMError ? error.message : "operation failed; check the selected files and installed tools";
    const detail=snapshot?snapshotFailureDetail(error):undefined;
    const report = decodeCliReport({ schemaVersion: 2, kind: "error", command, error: { code, message,...(detail===undefined?{}:{detail}) } });
    io.stdout(json ? `${JSON.stringify(report)}\n` : snapshot&&!interrupted ? snapshotFailureText(code,detail) : `${code}: ${message}\n`);
    return interrupted ? cancellationExit(io.signal) : detail?.["reason"]==="snapshot-verify-failed"?3:code === "INVALID_ARGUMENT" || code === "FEATURE_NOT_AVAILABLE"||snapshot&&code==="CORE_LOAD_FAILED" ? 2 : 1;
  }
}
function successText(report:CliReport):string {
  if(report.kind==="result"){
    if(report.command==="snapshot build"||report.command==="snapshot pack")return `Snapshot ${report.result.name} verified in ${report.result.verification.browser}. Bundle: ${report.result.bundlePath}. SDK options: ${report.result.referencePath}\n`;
    if(report.command==="snapshot init")return `Created ${report.result.directory}. Edit prepare.ts, then run oxidevm snapshot build ${report.result.recipePath}.\n`;
    if(report.command==="snapshot test")return `Snapshot ${report.result.name} restoration ${report.result.result} (${report.result.browser.name} ${report.result.browser.version}).\n`;
    if(report.command==="snapshot inspect")return `${report.result.kind==="bundle"?report.result.name:"Personal backup"}: ${report.result.snapshot.mode}, integrity verified; authentication ${report.result.authentication.kind}; runtime restoration not run.\n`;
  }
  return `${JSON.stringify(report,null,2)}\n`;
}
