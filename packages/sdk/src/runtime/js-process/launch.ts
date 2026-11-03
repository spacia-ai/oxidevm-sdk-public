import { boolean, exactKeys, record, string } from "../decode.js";
import { isModuleCommandName, moduleCommandPath } from "../module-command-names.js";
import type { ModuleCommandTerminals } from "../userspace-command-abi.js";
import { protocol } from "./codec.js";

/** The longest launch description the module runner accepts, in UTF-8 bytes. */
export const RUNNER_LAUNCH_DESCRIPTOR_BYTES = 512 * 1024;
/** A manifest declares at most 64 artifacts. */
const MAX_ARTIFACTS = 64;

/**
 * What the SDK's module runner starts with (engine ADR 0027, amended by ADR 0028), in its start message (JS process
 * protocol 5) rather than the process's argv, so `/proc/<pid>/cmdline` shows only the caller's arguments. Only the
 * runner's bootstrap accepts it; a worker served with `serveProcess` refuses it. Internal: never a public type.
 *
 * Both kinds carry the copies the VM's verified-copy store checked before the process existed, so the runner fetches
 * and hashes nothing. `host` is `spawnModule`'s start. `module-command` is a program in the VM that ran an enabled
 * command, held by the command's registration.
 */
/** One verified file: its bytes, and its compiled module when it is a WebAssembly core module that compiles. */
export interface RunnerVerifiedFile { readonly blob: Blob; readonly module: WebAssembly.Module | null }
/** The verified copies of a release: the adapter bundle and every artifact by its declared name. */
export interface RunnerCopies {
  readonly adapter: Blob;
  readonly artifacts: Readonly<Record<string, RunnerVerifiedFile>>;
  /** The engine's TLS module for a module with a network reach (engine ADR 0029), compiled by the broker; else null. */
  readonly tls: RunnerVerifiedFile | null;
}
export interface RunnerHostLaunch extends RunnerCopies {
  readonly kind: "host";
  /** `spawnModule`'s launch description, with the consumer's options resolved. */
  readonly descriptor: string;
}
export interface RunnerCommandLaunch extends RunnerCopies {
  readonly kind: "module-command";
  /** The enabled name the program ran and its stub's canonical path. */
  readonly invocation: { readonly name: string; readonly path: string };
  /** Whether descriptors 0-2 of the process are terminals, as Rust saw them at exec. */
  readonly terminals: ModuleCommandTerminals;
  /** The application's launch description, exactly as it turned the commands on. */
  readonly descriptor: string;
}
export type RunnerLaunch = RunnerHostLaunch | RunnerCommandLaunch;

function descriptorText(value: unknown): string {
  const descriptor = string(value, "module runner launch description");
  if (descriptor.length > RUNNER_LAUNCH_DESCRIPTOR_BYTES || new TextEncoder().encode(descriptor).byteLength > RUNNER_LAUNCH_DESCRIPTOR_BYTES) protocol("Module runner launch description exceeds its limit");
  return descriptor;
}

function verifiedFile(value: unknown): RunnerVerifiedFile {
  const file = record(value, "verified module file"); exactKeys(file, ["blob", "module"]);
  const blob = file["blob"], module = file["module"];
  if (!(blob instanceof Blob) || module !== null && !(module instanceof WebAssembly.Module)) protocol("Invalid verified module file");
  return { blob, module };
}

function copies(launch: Readonly<Record<string, unknown>>): RunnerCopies {
  const adapter = launch["adapter"], files = record(launch["artifacts"], "verified module files");
  if (!(adapter instanceof Blob) || Object.keys(files).length > MAX_ARTIFACTS) protocol("Invalid verified module files");
  return { adapter, artifacts: Object.fromEntries(Object.entries(files).map(([artifact, file]) => [artifact, verifiedFile(file)])), tls: launch["tls"] === null ? null : verifiedFile(launch["tls"]) };
}

/** Checks the transport shape of the runner's launch; the runner checks the description and the copies against each other. */
export function decodeRunnerLaunch(value: unknown): RunnerLaunch {
  const launch = record(value, "module runner launch");
  if (launch["kind"] === "host") {
    exactKeys(launch, ["kind", "descriptor", "adapter", "artifacts", "tls"]);
    return { kind: "host", descriptor: descriptorText(launch["descriptor"]), ...copies(launch) };
  }
  if (launch["kind"] !== "module-command") protocol("Unknown module runner launch");
  exactKeys(launch, ["kind", "invocation", "terminals", "descriptor", "adapter", "artifacts", "tls"]);
  const invocation = record(launch["invocation"], "module command invocation"); exactKeys(invocation, ["name", "path"]);
  const name = string(invocation["name"], "module command name");
  if (!isModuleCommandName(name) || invocation["path"] !== moduleCommandPath(name)) protocol("Invalid module command invocation");
  const terminals = record(launch["terminals"], "module command terminals"); exactKeys(terminals, ["stdin", "stdout", "stderr"]);
  return {
    kind: "module-command", invocation: { name, path: moduleCommandPath(name) },
    terminals: { stdin: boolean(terminals["stdin"], "stdin terminal"), stdout: boolean(terminals["stdout"], "stdout terminal"), stderr: boolean(terminals["stderr"], "stderr terminal") },
    descriptor: descriptorText(launch["descriptor"]), ...copies(launch),
  };
}
