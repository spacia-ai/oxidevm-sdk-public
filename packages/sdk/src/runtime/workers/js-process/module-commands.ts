import { VMError } from "../../errors.js";
import type { RunnerCommandLaunch } from "../../js-process/launch.js";
import type { ModuleCommandProgram } from "../../userspace-command-abi.js";
import { decodeModuleCommandApplication, encodeModuleCommandTable, MODULE_COMMAND_MAX_NAMES, type ModuleCommandApplication, type ModuleCommandEntry } from "../../userspace-module-commands-abi.js";
import { moduleCommandPath } from "../../module-command-names.js";
import { MODULE_COMMAND_REASONS as REASONS, type ModuleCommandsRequest, type ModuleCommandsResult, type ModuleCommandSkipReason, type SkippedModuleCommand } from "../../protocol/userspace-module-commands.js";
import { assertUserspaceStatus, callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { isServiceDecl } from "../../../wasm/manifest.js";
import { resolveOptions } from "../../../wasm/options.js";
import { moduleReach, type ModuleReach } from "../../../wasm/reach.js";
import { parseLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { assertRunsInModuleFrame, holdModuleFiles, suppliedFiles, type VerifiedModuleFiles } from "./module-artifacts.js";
import type { ModuleCopies } from "./module-copies.js";

/** Registrations one VM holds at once. */
export const MODULE_COMMAND_REGISTRATIONS = 16;

/** A mounted runtime's `oxidevm_userspace_module_commands_apply`: an OXMC v1 table in, its OXMA v1 record out. */
export interface ModuleCommandTableRuntime { applyTable(request: Uint8Array<ArrayBuffer>): Uint8Array }

/** The engine export of `runtime`, staged and read like every other record export. */
export function nativeModuleCommandTable(runtime: { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }): ModuleCommandTableRuntime {
  return {
    applyTable(request) {
      assertUserspaceStatus(call(runtime.instance, "oxidevm_userspace_staging_resize", request.byteLength), "module command staging");
      new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), request.byteLength).set(request);
      assertUserspaceStatus(call(runtime.instance, "oxidevm_userspace_module_commands_apply", request.byteLength), "module command table");
      return readFileRecord(runtime);
    },
  };
}

export interface ModuleCommandsPorts {
  /** The runtime the table applies to: mounted, published and ready; undefined otherwise. */
  readonly runtime: () => ModuleCommandTableRuntime | undefined;
  readonly environment: () => { readonly crossOriginIsolated: boolean; readonly initialUser: "user" | "root" };
  /** The VM's verified copies and their budget (`module-copies.ts`), shared with `spawnModule`. */
  readonly copies: ModuleCopies;
  /** An application changed `/usr/local/bin`: persist the system files and let waiting guest programs see it. */
  readonly changed: () => void;
}

interface Registration {
  readonly id: number;
  /** Sorted, as the manifest declares them. */
  readonly names: readonly string[];
  readonly concurrency: number;
  /** The network reach its module declared (engine ADR 0029), which Rust gives each of its command processes. */
  readonly reach: ModuleReach;
  readonly descriptor: string;
  readonly files: VerifiedModuleFiles;
  /** Names the last application left without a stub. */
  skipped: ReadonlyMap<string, ModuleCommandSkipReason>;
}

/** Names and a registration slot held by an enable that is still fetching. */
interface Reservation { readonly names: readonly string[] }

const fail = (code: ConstructorParameters<typeof VMError>[0], reason: string, message: string): VMError => new VMError(code, message, { reason });
/** Read through a call, because the signal changes while an enable awaits its files. */
const cancelled = (signal: AbortSignal): boolean => signal.aborted;
const cancellation = (): VMError => new VMError("ABORTED", "Turning module commands on was cancelled");

/**
 * A VM's module commands (engine ADR 0027), owned by the Userspace worker for as long as it runs: the registrations, their
 * verified copies and the whole table Rust applies to `/usr/local/bin`. Registrations live in memory only. The table is
 * applied when commands are turned on or off, and again whenever the runtime instance is replaced, but never before this
 * VM's first enable: every application removes the stubs it does not name, and a stub persisted by an earlier session
 * keeps explaining itself (exit 126) until the application turns its commands on again.
 */
export class ModuleCommands {
  readonly #ports: ModuleCommandsPorts;
  readonly #registrations = new Map<number, Registration>();
  readonly #pending = new Set<Reservation>();
  #last = 0;
  #applied = false;

  constructor(ports: ModuleCommandsPorts) { this.#ports = ports; }

  async request(request: ModuleCommandsRequest, signal: AbortSignal): Promise<ModuleCommandsResult> {
    switch (request.operation) {
      case "enable": return { operation: "enable", ...await this.#enable(request, signal) };
      case "disable": this.#disable(request.registration); return { operation: "disable" };
      case "status": {
        const registration = this.#registrations.get(request.registration);
        return { operation: "status", enabled: registration !== undefined, skipped: registration === undefined ? [] : skippedOf(registration) };
      }
    }
  }

  /**
   * Applies the whole table to a runtime that replaces the VM's (a fresh start from files, a published cold start or a
   * restore), once this VM has turned commands on. A failure never fails the replacement: every name reports it.
   */
  reapply(runtime: ModuleCommandTableRuntime): void {
    if (!this.#applied) return;
    const registrations = [...this.#registrations.values()];
    try { this.#apply(runtime, registrations); }
    catch { for (const registration of registrations) registration.skipped = new Map(registration.names.map(name => [name, "unavailable"])); }
  }

  /** The verified copies the runner of `program` starts with, or undefined when its registration no longer has that command. */
  launch(program: ModuleCommandProgram): RunnerCommandLaunch | undefined {
    const registration = this.#registrations.get(program.registration);
    if (registration === undefined || !registration.names.includes(program.name) || program.path !== moduleCommandPath(program.name)) return undefined;
    return { kind: "module-command", invocation: { name: program.name, path: program.path }, terminals: program.terminals, descriptor: registration.descriptor, adapter: registration.files.adapter, artifacts: registration.files.artifacts, tls: registration.files.tls };
  }

  /** The VM is going away: drop every registration; the worker disposes of the copies. Runs already started keep theirs. */
  dispose(): void { this.#registrations.clear(); this.#pending.clear(); }

  #available(): ModuleCommandTableRuntime {
    const { crossOriginIsolated, initialUser } = this.#ports.environment();
    if (!crossOriginIsolated) throw fail("FEATURE_NOT_AVAILABLE", REASONS.unavailable, "Module commands require a cross-origin isolated page");
    if (initialUser !== "user") throw fail("FEATURE_NOT_AVAILABLE", REASONS.unavailable, "Module commands run as uid 1000 and are refused for a root initial user");
    const runtime = this.#ports.runtime();
    if (runtime === undefined) throw fail("FEATURE_NOT_AVAILABLE", REASONS.unavailable, "Module commands require a VM with a mounted image");
    return runtime;
  }

  async #enable(request: Extract<ModuleCommandsRequest, { readonly operation: "enable" }>, signal: AbortSignal): Promise<Omit<Extract<ModuleCommandsResult, { readonly operation: "enable" }>, "operation">> {
    if (cancelled(signal)) throw cancellation();
    this.#available();
    const descriptor = parseLaunchArgument(request.descriptor), { manifest } = descriptor;
    const declared = isServiceDecl(manifest) ? [] : manifest.commands ?? [];
    if (declared.length === 0) throw fail("INVALID_ARGUMENT", REASONS.commands, `${manifest.id} declares no commands`);
    if (request.commands.length === 0 || new Set(request.commands).size !== request.commands.length) throw fail("INVALID_ARGUMENT", REASONS.commands, "Name each command once, at least one");
    const undeclared = request.commands.find(name => !declared.includes(name));
    if (undeclared !== undefined) throw fail("INVALID_ARGUMENT", REASONS.commands, `${undeclared} is not a command of ${manifest.id}`);
    // Options are fixed when commands are turned on, because a guest cannot pass any.
    resolveOptions(manifest.options, descriptor.options);
    assertRunsInModuleFrame(manifest);
    const names = declared.filter(name => request.commands.includes(name)), reservation = { names };
    this.#reserve(reservation);
    const id = ++this.#last, holder = { kind: "registration", id } as const, { copies } = this.#ports;
    try {
      const files = await holdModuleFiles(descriptor, holder, { copies, supply: suppliedFiles(request.files) }, signal);
      if (cancelled(signal)) throw cancellation();
      const runtime = this.#available();
      const registration: Registration = { id, names, concurrency: request.concurrency, reach: moduleReach(manifest.requires.host), descriptor: request.descriptor, files, skipped: new Map() };
      this.#apply(runtime, [...this.#registrations.values(), registration]);
      this.#registrations.set(registration.id, registration);
      this.#applied = true;
      return { registration: registration.id, commands: names, skipped: skippedOf(registration) };
    } catch (error: unknown) {
      copies.release(holder);
      // A refused enable registered nothing: its id goes back unless a later enable was issued one meanwhile.
      if (this.#last === id) this.#last = id - 1;
      if (cancelled(signal) && !(error instanceof VMError && error.code === "ABORTED")) throw cancellation();
      throw error;
    } finally { this.#pending.delete(reservation); }
  }

  /** Refuses names held by another registration, enabled or still verifying, and the VM's bounds; then holds them. */
  #reserve(reservation: Reservation): void {
    const held = [...this.#registrations.values(), ...this.#pending];
    const taken = reservation.names.find(name => held.some(other => other.names.includes(name)));
    if (taken !== undefined) throw fail("INVALID_ARGUMENT", REASONS.conflict, `${taken} is already turned on in this VM by another registration`);
    const names = held.reduce((total, other) => total + other.names.length, reservation.names.length);
    if (held.length >= MODULE_COMMAND_REGISTRATIONS || names > MODULE_COMMAND_MAX_NAMES) {
      throw new VMError("QUOTA_EXCEEDED", `A VM holds at most ${String(MODULE_COMMAND_REGISTRATIONS)} registrations and ${String(MODULE_COMMAND_MAX_NAMES)} commands`, { reason: REASONS.limit });
    }
    this.#pending.add(reservation);
  }

  /** Re-applies the table first, so Rust admits none of its stubs any more, then drops its copies. */
  #disable(id: number): void {
    const registration = this.#registrations.get(id);
    if (registration === undefined) return;
    const runtime = this.#ports.runtime();
    if (runtime !== undefined) this.#apply(runtime, [...this.#registrations.values()].filter(other => other !== registration));
    this.#registrations.delete(id);
    this.#ports.copies.release({ kind: "registration", id });
  }

  /** Applies `registrations` as the whole table and records what each one's names got; throws a typed error when refused. */
  #apply(runtime: ModuleCommandTableRuntime, registrations: readonly Registration[]): void {
    const entries = registrations.flatMap(registration => registration.names.map((name): ModuleCommandEntry => ({ registration: registration.id, concurrency: registration.concurrency, reach: registration.reach, name })));
    const application = decodeModuleCommandApplication(runtime.applyTable(encodeModuleCommandTable(entries)), entries.length);
    if ((application.outcome === "applied" || application.outcome === "filesystem") && application.changed) this.#ports.changed();
    if (application.outcome !== "applied") throw refusal(application, entries);
    const skipped = new Set(application.skipped.map(skip => entries[skip.entry]?.name));
    for (const registration of registrations) registration.skipped = new Map(registration.names.filter(name => skipped.has(name)).map(name => [name, "occupied"]));
  }
}

function skippedOf(registration: Registration): readonly SkippedModuleCommand[] {
  return [...registration.skipped].map(([name, reason]) => ({ name, reason }));
}

/** Rust refused the table: a defect of the SDK, which validated it, or a state of the VM the page can act on. */
function refusal(application: Exclude<ModuleCommandApplication, { readonly outcome: "applied" }>, entries: readonly ModuleCommandEntry[]): VMError {
  switch (application.outcome) {
    case "malformed": case "invalid-name": case "duplicate": case "too-many":
      return new VMError("PROTOCOL_ERROR", `Rust refused the module command table (${application.outcome})`, { outcome: application.outcome });
    case "initial-user-root":
      return fail("FEATURE_NOT_AVAILABLE", REASONS.unavailable, "Module commands are refused for a root initial user");
    case "busy":
      return new VMError("STORAGE_ERROR", "The VM's system files are busy; turn the commands on again once it is idle", { outcome: "busy" });
    case "directory-unavailable":
      return new VMError("STORAGE_ERROR", "/usr/local/bin cannot hold module commands in this VM (a link, a file or read-only)", { outcome: "directory-unavailable" });
    case "filesystem": {
      const command = application.entry === null ? undefined : entries[application.entry]?.name;
      return new VMError("STORAGE_ERROR", `Placing module commands failed with errno ${String(application.errno)}`, { outcome: "filesystem", errno: application.errno, ...(command === undefined ? {} : { command }) });
    }
  }
}
