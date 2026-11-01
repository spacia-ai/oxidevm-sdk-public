import { boolean, exactKeys, record, string } from "../decode.js";
import { isModuleCommandName, moduleCommandPath } from "../module-command-names.js";
import type { ModuleCommandTerminals } from "../userspace-command-abi.js";
import { protocol } from "./codec.js";

/** The longest launch description the module runner accepts, in UTF-8 bytes. */
export const RUNNER_LAUNCH_DESCRIPTOR_BYTES = 512 * 1024;
/** A manifest declares at most 64 artifacts. */
const MAX_ARTIFACTS = 64;

/**
 * What the SDK's module runner starts with (engine ADR 0027), in its start message (JS process protocol 4) rather than
 * the process's argv, so `/proc/<pid>/cmdline` shows only the caller's arguments. Only the runner's bootstrap accepts
 * it; a worker served with `serveProcess` refuses it. Internal: never a public type.
 *
 * `host` is `spawnModule`'s start: the runner fetches and checks every pinned file. `module-command` is a program in the
 * VM that ran an enabled command: the Userspace worker's registration owner hands over the copies it verified when the
 * commands were turned on, so this run fetches and hashes nothing.
 */
export interface RunnerHostLaunch { readonly kind: "host"; readonly descriptor: string }
/** One verified file: its bytes, and its compiled module when it is a WebAssembly core module that compiles. */
export interface RunnerVerifiedFile { readonly blob: Blob; readonly module: WebAssembly.Module | null }
export interface RunnerCommandLaunch {
  readonly kind: "module-command";
  /** The enabled name the program ran and its stub's canonical path. */
  readonly invocation: { readonly name: string; readonly path: string };
  /** Whether descriptors 0-2 of the process are terminals, as Rust saw them at exec. */
  readonly terminals: ModuleCommandTerminals;
  /** The application's launch description, exactly as it turned the commands on. */
  readonly descriptor: string;
  readonly adapter: Blob;
  readonly artifacts: Readonly<Record<string, RunnerVerifiedFile>>;
}
export type RunnerLaunch = RunnerHostLaunch | RunnerCommandLaunch;

function descriptorText(value: unknown): string {
  const descriptor = string(value, "module runner launch description");
  if (descriptor.length > RUNNER_LAUNCH_DESCRIPTOR_BYTES || new TextEncoder().encode(descriptor).byteLength > RUNNER_LAUNCH_DESCRIPTOR_BYTES) protocol("Module runner launch description exceeds its limit");
  return descriptor;
}

/** What a page may ask the Userspace worker to start a runner with: `spawnModule`'s description, nothing else. */
export function decodeRunnerHostLaunch(value: unknown): RunnerHostLaunch {
  const launch = record(value, "module runner launch"); exactKeys(launch, ["kind", "descriptor"]);
  if (launch["kind"] !== "host") protocol("Unknown module runner launch");
  return { kind: "host", descriptor: descriptorText(launch["descriptor"]) };
}

function verifiedFile(value: unknown): RunnerVerifiedFile {
  const file = record(value, "verified module file"); exactKeys(file, ["blob", "module"]);
  const blob = file["blob"], module = file["module"];
  if (!(blob instanceof Blob) || module !== null && !(module instanceof WebAssembly.Module)) protocol("Invalid verified module file");
  return { blob, module };
}

/** Checks the transport shape of the runner's launch; the runner checks the description and the copies against each other. */
export function decodeRunnerLaunch(value: unknown): RunnerLaunch {
  const launch = record(value, "module runner launch");
  if (launch["kind"] !== "module-command") return decodeRunnerHostLaunch(launch);
  exactKeys(launch, ["kind", "invocation", "terminals", "descriptor", "adapter", "artifacts"]);
  const invocation = record(launch["invocation"], "module command invocation"); exactKeys(invocation, ["name", "path"]);
  const name = string(invocation["name"], "module command name");
  if (!isModuleCommandName(name) || invocation["path"] !== moduleCommandPath(name)) protocol("Invalid module command invocation");
  const terminals = record(launch["terminals"], "module command terminals"); exactKeys(terminals, ["stdin", "stdout", "stderr"]);
  const adapter = launch["adapter"], files = record(launch["artifacts"], "verified module files");
  if (!(adapter instanceof Blob) || Object.keys(files).length > MAX_ARTIFACTS) protocol("Invalid verified module files");
  return {
    kind: "module-command", invocation: { name, path: moduleCommandPath(name) },
    terminals: { stdin: boolean(terminals["stdin"], "stdin terminal"), stdout: boolean(terminals["stdout"], "stdout terminal"), stderr: boolean(terminals["stderr"], "stderr terminal") },
    descriptor: descriptorText(launch["descriptor"]), adapter,
    artifacts: Object.fromEntries(Object.entries(files).map(([artifact, file]) => [artifact, verifiedFile(file)])),
  };
}
