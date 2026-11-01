import { VMError, withCleanupFailure } from "../runtime/errors.js";
import { moduleCommandPath } from "../runtime/module-command-names.js";
import { MODULE_COMMAND_REASONS } from "../runtime/protocol/userspace-module-commands.js";
import { MODULE_COMMAND_MAX_CONCURRENCY } from "../runtime/userspace-module-commands-abi.js";
import { ownedModuleCommands, type OwnedModuleCommands } from "../vm-adapter.js";
import type { CommandName, Erased, ModuleHandle, OptionsField } from "./handle.js";
import { handleManifest, launchDescriptor } from "./launch-descriptor.js";
import { isServiceDecl } from "./manifest.js";
import type { ModuleDecl } from "./manifest-types.js";
import { encodeLaunchArgument } from "./runner/descriptor.js";
import type { ModuleVM } from "./spawn.js";

/**
 * Module commands on a VM's PATH (engine ADR 0027): an application turns a command module's declared `commands` on for
 * one Userspace VM, and every program there can then run the module as `/usr/local/bin/<name>`. The VM's Userspace
 * worker owns the registration: it fetches and checks every pinned file once, keeps the checked copies while the commands
 * stay on, and has Rust place each command's stub.
 */

/** How many runs of one call's commands may be active at once when the call names no `concurrency`. */
const DEFAULT_CONCURRENCY = 4;

/** Why a handle cannot turn commands on; the compiler names it when a service or a module without commands is passed. */
interface WithoutCommands { readonly "enableModuleCommands needs a command module that declares commands": never }

/** A handle whose module declares commands. A loaded handle's manifest has no literal type, so the call checks it. */
type CommandModuleHandle<M extends ModuleDecl> = ModuleHandle<M> & (Erased<M> extends true ? unknown : [CommandName<M>] extends [never] ? WithoutCommands : unknown);

/** What `enableModuleCommands` may be given when the manifest's literal type is unknown; the call checks it at run time. */
export interface ErasedEnableCommandsOptions<N extends string = string> {
  readonly commands?: readonly N[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

/**
 * The options of `enableModuleCommands`, derived from the manifest: `commands` names some of the declared commands
 * (all of them when absent), `options` holds the module's declared options, required when one has no default, and
 * `concurrency` bounds how many runs may be active at once (1 to 32, default 4). There is no `args`, `cwd` or `env`:
 * the program that runs a command supplies its own.
 */
export type EnableCommandsOptions<M extends ModuleDecl, N extends string = CommandName<M>> = Erased<M> extends true
  ? ErasedEnableCommandsOptions<N>
  : { readonly commands?: readonly N[]; readonly concurrency?: number; readonly signal?: AbortSignal } & OptionsField<M>;

/** The optional or required options argument of `enableModuleCommands`, derived from the manifest. */
export type EnableCommandsArgs<M extends ModuleDecl, N extends string = CommandName<M>> = Record<never, never> extends EnableCommandsOptions<M, N>
  ? [options?: EnableCommandsOptions<M, N>]
  : [options: EnableCommandsOptions<M, N>];

/**
 * A command that is on but has no stub: another file holds its path and is left as it is (`occupied`), or placing the
 * VM's stubs failed the last time they were placed, at a restore or a reload of its runtime (`unavailable`).
 */
export interface SkippedModuleCommand<N extends string = string> {
  readonly name: N;
  readonly reason: "occupied" | "unavailable";
}

export interface ModuleCommandsStatus<N extends string = string> {
  /** Whether the commands are still on: false after `disable()` and once the VM is disposed. */
  readonly enabled: boolean;
  /** The commands that are on but have no stub, and why. */
  readonly skipped: readonly SkippedModuleCommand<N>[];
}

/** The commands one `enableModuleCommands` call turned on in a VM. `N` is their names: all the module declares by default. */
export interface ModuleCommands<M extends ModuleDecl = ModuleDecl, N extends CommandName<M> = CommandName<M>> {
  /** The names this call turned on, in the manifest's order. */
  readonly commands: readonly N[];
  /** Where programs in the VM run each command: the path of its stub. */
  readonly paths: { readonly [K in N]: `/usr/local/bin/${K}` };
  /** Which of the commands are on and which have no stub. */
  status(): Promise<ModuleCommandsStatus<N>>;
  /**
   * Turns the commands off: their stubs are removed and the checked copies dropped, while runs that already started
   * finish with theirs. Calling it again, or once the VM is disposed, does nothing.
   */
  disable(): Promise<void>;
}

/** The decoded call: its launch description with the options resolved, and the names in the manifest's order. */
interface EnableRequest {
  readonly descriptor: string;
  readonly commands: readonly string[];
  readonly concurrency: number;
  readonly signal: AbortSignal | undefined;
}

const FIELDS: ReadonlySet<string> = new Set(["commands", "options", "concurrency", "signal"]);
const refuse = (message: string): VMError => new VMError("INVALID_ARGUMENT", message, { reason: MODULE_COMMAND_REASONS.commands });
const cancelled = (): VMError => new VMError("ABORTED", "Turning module commands on was cancelled");
/** Read through a call, because a signal changes while the call awaits the VM. */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const offState = (): ModuleCommandsStatus => ({ enabled: false, skipped: [] });

/** The names a call turns on: all declared commands when it names none, otherwise each named one once, in the manifest's order. */
function requestedCommands(value: unknown, declared: readonly string[], id: string): readonly string[] {
  if (value === undefined) return declared;
  if (!Array.isArray(value)) throw refuse("commands must be a list of the module's command names");
  const names = Array.from<unknown>(value);
  if (names.length === 0) throw refuse("commands must name at least one command");
  if (new Set(names).size !== names.length) throw refuse("commands must name each command once");
  const undeclared = names.find(name => typeof name !== "string" || !declared.includes(name));
  if (undeclared !== undefined) throw refuse(`${typeof undeclared === "string" ? JSON.stringify(undeclared.slice(0, 64)) : "A value that is not a name"} is not a command of ${id}`);
  return declared.filter(name => names.includes(name));
}

/** Decodes the call as untrusted input. Every failure is INVALID_ARGUMENT and comes before anything is fetched. */
function decodeEnable(handle: unknown, input: unknown): EnableRequest {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) throw refuse("The options of enableModuleCommands must be an object");
  const fields: Readonly<Record<string, unknown>> = input === undefined ? {} : Object.fromEntries(Object.entries(input));
  const other = Object.keys(fields).find(key => !FIELDS.has(key));
  if (other !== undefined) throw refuse(`enableModuleCommands takes commands, options, concurrency and signal, not ${other}: a program that runs a command supplies its own arguments, directory and environment`);
  const signal = fields["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw refuse("signal must be an AbortSignal");
  const manifest = handleManifest(handle);
  if (isServiceDecl(manifest)) throw refuse(`${manifest.id} is a service; only a command module runs as a program`);
  const declared = manifest.commands ?? [];
  if (declared.length === 0) throw refuse(`${manifest.id} declares no commands`);
  const commands = requestedCommands(fields["commands"], declared, manifest.id);
  const concurrency = fields["concurrency"] ?? DEFAULT_CONCURRENCY;
  if (typeof concurrency !== "number" || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MODULE_COMMAND_MAX_CONCURRENCY) {
    throw refuse(`concurrency must be an integer from 1 to ${String(MODULE_COMMAND_MAX_CONCURRENCY)}`);
  }
  // The options are fixed now, defaults included, because a program that runs a command cannot pass any.
  const descriptor = encodeLaunchArgument(launchDescriptor(handle, { options: fields["options"], workspaceId: undefined }));
  return { descriptor, commands, concurrency, signal };
}

/** The handle of one registration. It holds only the registration's id: the VM's Userspace worker owns its state. */
function registered(owner: OwnedModuleCommands, registration: number, names: readonly string[]): ModuleCommands {
  const own = (name: string): string => {
    const found = names.find(candidate => candidate === name);
    if (found === undefined) throw new VMError("PROTOCOL_ERROR", "The VM reported a command this registration does not hold");
    return found;
  };
  return Object.freeze({
    commands: Object.freeze([...names]),
    paths: Object.freeze(Object.fromEntries(names.map(name => [name, moduleCommandPath(name)]))),
    // A disposed VM refuses requests, and one disposed meanwhile fails them: its worker, and every registration, is gone.
    status: async (): Promise<ModuleCommandsStatus> => {
      try {
        const answer = await owner.request({ operation: "status", registration });
        if (answer.operation !== "status") throw new VMError("PROTOCOL_ERROR", "The VM answered a status request with another result");
        return { enabled: answer.enabled, skipped: answer.skipped.map(skip => ({ name: own(skip.name), reason: skip.reason })) };
      } catch (error: unknown) {
        if (aborted(owner.disposed)) return offState();
        throw error;
      }
    },
    disable: async (): Promise<void> => {
      try {
        // The worker ignores an id it no longer holds, so a second call does nothing.
        const answer = await owner.request({ operation: "disable", registration });
        if (answer.operation !== "disable") throw new VMError("PROTOCOL_ERROR", "The VM answered a disable request with another result");
      } catch (error: unknown) {
        if (!aborted(owner.disposed)) throw error;
      }
    },
  });
}

/**
 * Turns a command module's `commands` on for one Userspace VM (engine ADR 0027). The VM's Userspace worker fetches every
 * pinned file of the release once, checks it against its pin and keeps the checked copies; Rust then places a stub at
 * `/usr/local/bin/<name>` for each command, and every program in the VM that runs one runs the module as that process.
 * Options are fixed by this call. When it fails, nothing is turned on.
 */
export function enableModuleCommands<const M extends ModuleDecl, const N extends CommandName<M> = CommandName<M>>(vm: ModuleVM, handle: CommandModuleHandle<M>, ...args: EnableCommandsArgs<M, N>): Promise<ModuleCommands<M, N>>;
export async function enableModuleCommands(vm: ModuleVM, handle: ModuleHandle, ...args: readonly unknown[]): Promise<ModuleCommands> {
  // The overload above fixes the argument types for callers; this body decodes them as untrusted input.
  const request = decodeEnable(handle, args[0]);
  const owner = ownedModuleCommands(vm), { signal } = request;
  if (aborted(signal)) throw cancelled();
  const answer = await owner.request({ operation: "enable", descriptor: request.descriptor, commands: request.commands, concurrency: request.concurrency }, signal);
  if (answer.operation !== "enable" || answer.commands.length !== request.commands.length || answer.commands.some((name, index) => name !== request.commands[index])) {
    throw new VMError("PROTOCOL_ERROR", "The VM turned on other commands than it was asked to");
  }
  if (aborted(signal)) {
    // The worker registered the commands before the cancellation reached it: turn them off again, so nothing stays on.
    try { await owner.request({ operation: "disable", registration: answer.registration }); }
    catch (error: unknown) { throw withCleanupFailure(cancelled(), error); }
    throw cancelled();
  }
  return registered(owner, answer.registration, answer.commands);
}
