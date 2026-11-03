import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { RUNNER_LAUNCH_DESCRIPTOR_BYTES } from "../js-process/launch.js";
import { isModuleCommandName } from "../module-command-names.js";
import { MODULE_COMMAND_MAX_CONCURRENCY } from "../userspace-module-commands-abi.js";
import { decodeSuppliedFiles, type CopyKey } from "./userspace-module-files.js";

/**
 * The `module-commands` request of worker protocol 178 (engine ADR 0027, amended by ADR 0028): the page turns a command module's declared
 * commands on for its VM, turns them off, or asks how they stand. The Userspace worker's registration owner
 * (`workers/js-process/module-commands.ts`) answers; the control worker relays both directions unchanged.
 */

/** Stable `detail.reason` values of turning commands on. */
export const MODULE_COMMAND_REASONS = {
  /** The request names no commands, names one the module does not declare, or the module is a service or has none. */
  commands: "wasm-module-commands",
  /** A name another registration of this VM has turned on, or is turning on. */
  conflict: "wasm-module-command-conflict",
  /** This VM cannot run module commands: no cross-origin isolation, a root initial user or no mounted image. */
  unavailable: "wasm-module-command-unavailable",
  /** The VM's registrations, names or verified bytes would exceed their bounds. */
  limit: "wasm-module-command-limit",
} as const;

/** A manifest declares at most sixteen commands, so one registration turns at most sixteen on. */
export const MODULE_COMMANDS_PER_REGISTRATION = 16;

export type ModuleCommandsRequest =
  /** `files` holds the copies the VM's store lacked, by key (ADR 0028); the store checks them before anything is placed. */
  | { readonly operation: "enable"; readonly descriptor: string; readonly commands: readonly string[]; readonly concurrency: number; readonly files: Readonly<Record<CopyKey, Blob>> }
  | { readonly operation: "disable" | "status"; readonly registration: number };

/**
 * Why a turned-on name has no stub: another file holds its path and is kept (`occupied`), or the last application of the
 * table failed, so none of the names could be placed (`unavailable`).
 */
export type ModuleCommandSkipReason = "occupied" | "unavailable";
export interface SkippedModuleCommand { readonly name: string; readonly reason: ModuleCommandSkipReason }

/** Each answer names its operation, so the page decodes it without knowing which request it answers. */
export type ModuleCommandsResult =
  | { readonly operation: "enable"; readonly registration: number; readonly commands: readonly string[]; readonly skipped: readonly SkippedModuleCommand[] }
  | { readonly operation: "disable" }
  | { readonly operation: "status"; readonly enabled: boolean; readonly skipped: readonly SkippedModuleCommand[] };

function registrationId(value: unknown): number {
  return integer(value, "module command registration", 1, 0xffff_ffff);
}

/** At most sixteen distinct names of the module-command grammar; `allowEmpty` for an answer's skipped list. */
function names(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || value.length > MODULE_COMMANDS_PER_REGISTRATION || !allowEmpty && value.length === 0) throw new VMError("PROTOCOL_ERROR", `${label} must list 1 to ${String(MODULE_COMMANDS_PER_REGISTRATION)} commands`);
  const decoded = Array.from<unknown>(value).map(name => string(name, label));
  if (decoded.some(name => !isModuleCommandName(name)) || new Set(decoded).size !== decoded.length) throw new VMError("PROTOCOL_ERROR", `${label} must be distinct module command names`);
  return decoded;
}

/** The fields after the envelope (`id`, `version` and `type` of a worker request by default), exactly. */
export function decodeModuleCommandsRequest(request: Readonly<Record<string, unknown>>, envelope: readonly string[] = ["id", "version", "type"]): ModuleCommandsRequest {
  const operation = request["operation"];
  switch (operation) {
    case "enable": {
      exactKeys(request, [...envelope, "operation", "descriptor", "commands", "concurrency", "files"]);
      const descriptor = string(request["descriptor"], "module command launch description");
      if (descriptor.length > RUNNER_LAUNCH_DESCRIPTOR_BYTES || new TextEncoder().encode(descriptor).byteLength > RUNNER_LAUNCH_DESCRIPTOR_BYTES) throw new VMError("PROTOCOL_ERROR", "Module command launch description exceeds its limit");
      return { operation, descriptor, commands: names(request["commands"], "module commands"), concurrency: integer(request["concurrency"], "module command concurrency", 1, MODULE_COMMAND_MAX_CONCURRENCY), files: decodeSuppliedFiles(request["files"]) };
    }
    case "disable":
    case "status":
      exactKeys(request, [...envelope, "operation", "registration"]);
      return { operation, registration: registrationId(request["registration"]) };
    default:
      throw new VMError("PROTOCOL_ERROR", "Unknown module-commands operation");
  }
}

function skippedCommands(value: unknown): readonly SkippedModuleCommand[] {
  if (!Array.isArray(value) || value.length > MODULE_COMMANDS_PER_REGISTRATION) throw new VMError("PROTOCOL_ERROR", "Skipped module commands must be a bounded list");
  const skipped = Array.from<unknown>(value).map((item): SkippedModuleCommand => {
    const entry = record(item, "skipped module command"); exactKeys(entry, ["name", "reason"]);
    const reason = entry["reason"];
    if (reason !== "occupied" && reason !== "unavailable") throw new VMError("PROTOCOL_ERROR", "Unknown module command skip reason");
    return { name: string(entry["name"], "skipped module command name"), reason };
  });
  names(skipped.map(entry => entry.name), "skipped module commands", true);
  return skipped;
}

export function decodeModuleCommandsResult(value: unknown): ModuleCommandsResult {
  const result = record(value, "module-commands result");
  switch (result["operation"]) {
    case "enable": {
      exactKeys(result, ["operation", "registration", "commands", "skipped"]);
      const commands = names(result["commands"], "enabled module commands"), skipped = skippedCommands(result["skipped"]);
      if (skipped.some(entry => !commands.includes(entry.name))) throw new VMError("PROTOCOL_ERROR", "A skipped module command was not enabled");
      return { operation: "enable", registration: registrationId(result["registration"]), commands, skipped };
    }
    case "disable":
      exactKeys(result, ["operation"]);
      return { operation: "disable" };
    case "status": {
      exactKeys(result, ["operation", "enabled", "skipped"]);
      const enabled = boolean(result["enabled"], "module commands enabled"), skipped = skippedCommands(result["skipped"]);
      if (!enabled && skipped.length > 0) throw new VMError("PROTOCOL_ERROR", "A registration that is off reports skipped commands");
      return { operation: "status", enabled, skipped };
    }
    default:
      throw new VMError("PROTOCOL_ERROR", "Unknown module-commands result");
  }
}
