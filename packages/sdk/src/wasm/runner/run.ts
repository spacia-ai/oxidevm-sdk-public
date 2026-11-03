import type { LinuxProcessInfo } from "../../js-process-types.js";
import { VMError } from "../../runtime/errors.js";
import type { RunnerLaunch } from "../../runtime/js-process/launch.js";
import { MODULE_EXIT } from "../exit-codes.js";
import type { CommandIO } from "../define.js";
import type { ResolvedManifest } from "../manifest-types.js";
import { isServiceDecl } from "../manifest.js";
import { resolveOptions } from "../options.js";
import { preverifiedArtifacts, type SyncBlobReader, type VerifiedArtifacts } from "./artifacts.js";
import { parseLaunchArgument, type LaunchDescriptor } from "./descriptor.js";
import { failureLine, ModuleFailure, type RunnerReport } from "./failure.js";
import { writeGuestFiles } from "./guest-files.js";
import { AdapterShapeError, commandRun, serviceRun } from "./hooks.js";
import { buildHost, type LinuxParts, type UndeclaredAccess } from "./host.js";
import { runnerStart, type RunnerStart } from "./launch.js";
import { RunnerSignals, type SignalTransport } from "./signals.js";
import { missingPrerequisites, type BrowserProbe } from "./prerequisites.js";
import { DEFAULT_CLIENTS, leftoverCheck, runService } from "./service.js";
import type { NetPorts } from "../net/ports.js";
import type { TlsLayer } from "../net/streams.js";
import { createModuleNetwork, installNetworkGlobals, type DirectAttempt, type ModuleNetwork, type ReachRefusal } from "../net/surface.js";
import { moduleReach } from "../reach.js";

/** Where a module's network lives (engine ADR 0029): the process's VM sockets and the global scope its `fetch` goes into. */
export interface RunnerNetwork {
  readonly ports: NetPorts;
  /** The worker's global scope; tests pass a plain object. */
  readonly scope: object;
  /** TLS; the engine's client unless a test host supplies another. */
  readonly tls?: TlsLayer;
  /** The worker's own `fetch`, kept for `blob:` URLs. */
  readonly local?: typeof fetch;
}

/** Everything the runner touches outside the Linux process: injected so tests can fake the browser. */
export interface RunnerContext extends LinuxParts {
  readonly browser: BrowserProbe;
  /** Evaluates a verified adapter bundle as an ES module and returns its namespace. */
  readonly importAdapter: (bundle: Blob) => Promise<unknown>;
  /** The process's signals (JS process protocol 4), behind `host.process.signals`. */
  readonly signals: SignalTransport;
  /** The module network; without it a module gets no `host.net` and its scope is left as it is. */
  readonly network?: RunnerNetwork;
  /** Reads a verified copy without awaiting (`host.artifacts.bytesSync`); the worker's `FileReaderSync` by default. */
  readonly readBlobSync?: SyncBlobReader;
}

const encoder = new TextEncoder();
const MAX_STACK = 2048;

async function writeLine(context: RunnerContext, fd: RunnerContext["stdout"], value: unknown): Promise<void> {
  await context.files.writeAll(fd, encoder.encode(`${JSON.stringify(value)}\n`));
}

function parseEnvironment(entries: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(entries.flatMap(entry => {
    const cut = entry.indexOf("=");
    return cut <= 0 ? [] : [[entry.slice(0, cut), entry.slice(cut + 1)] as const];
  }));
}

function adapterFactory(imported: unknown): (...args: unknown[]) => unknown {
  const factory: unknown = typeof imported === "object" && imported !== null ? Reflect.get(imported, "default") : undefined;
  if (typeof factory !== "function") throw new AdapterShapeError("The adapter bundle must export a factory function as its default export");
  return (...args) => {
    const result: unknown = Reflect.apply(factory, undefined, args);
    return result;
  };
}

async function runCommand(context: RunnerContext, manifest: ResolvedManifest, hooks: unknown, process: Process): Promise<number> {
  const run = commandRun(hooks);
  const { start, info } = process;
  const io: CommandIO<string> = {
    args: start.args, env: parseEnvironment(info.environment), cwd: info.cwd, stdin: context.stdin, stdout: context.stdout, stderr: context.stderr,
    invocation: start.invocation, terminals: start.terminals,
  };
  let status: unknown;
  try {
    status = await run.main(io);
  } finally {
    await run.close();
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > MODULE_EXIT.adapterMax) {
    throw new AdapterShapeError(`${manifest.id}: main must return an integer exit status from 0 to ${String(MODULE_EXIT.adapterMax)}`, "exit-status");
  }
  return status;
}

/** One start of the runner: how it was started, and the process as Rust reports it. */
interface Process { readonly start: RunnerStart; readonly info: LinuxProcessInfo }

/** What one start owns until the module ends. */
interface Run {
  readonly process: Process;
  readonly artifacts: VerifiedArtifacts;
  readonly lifecycle: AbortController;
  /** Undeclared members the adapter reached, for the fault report. */
  readonly undeclared: Map<string, UndeclaredAccess>;
  readonly signals: RunnerSignals;
}

async function start(context: RunnerContext, descriptor: LaunchDescriptor, { process, artifacts, lifecycle, undeclared, signals }: Run): Promise<number> {
  const { manifest } = descriptor, guest = process.start.invocation.kind === "command";
  let options;
  try { options = resolveOptions(manifest.options, descriptor.options); }
  catch (error: unknown) { throw new ModuleFailure("launch", error instanceof Error ? error.message : "The options are invalid"); }
  const missing = await missingPrerequisites(manifest, context.browser, context.files);
  if (missing.length > 0) throw new ModuleFailure("prerequisite", `Missing: ${missing.join(", ")}`, missing);
  // Every file the release pins was checked by the VM's store before this process existed (engine ADR 0028).
  const adapter = await artifacts.adapter();
  await writeGuestFiles(context.files, manifest, artifacts);
  const warn = (record: Readonly<Record<string, unknown>>): void => {
    // A program in the VM reads a command's own output on standard error, so only an application gets records; each once.
    const key = JSON.stringify(record);
    if (guest || warned.has(key) || warned.size >= MAX_NETWORK_WARNINGS) return;
    warned.add(key);
    void writeLine(context, context.stderr, { oxidevm: "warning", v: 1, ...record }).catch(() => undefined);
  };
  const warned = new Set<string>();
  const refused = (destination: ReachRefusal): void => { warn({ kind: "network-reach", ...destination }); };
  const net = moduleNetwork(context, manifest, lifecycle.signal, {
    refused,
    direct: attempt => { warn({ kind: "network-direct", ...attempt }); },
  });
  const factory = adapterFactory(await context.importAdapter(adapter));
  const { host, log } = buildHost({
    ...(net?.host === undefined ? {} : { net: net.host }), refused,
    linux: context, capabilities: manifest.requires.host, options, artifacts, signal: lifecycle.signal, signals: signals.api,
    // Reaching for an undeclared member is remembered for the fault report, and reported once per member to an
    // application; a program in the VM reads the command's own output on standard error, so it gets no record.
    undeclared: access => {
      if (undeclared.has(access.member)) return;
      undeclared.set(access.member, access);
      if (!guest) void writeLine(context, context.stderr, { oxidevm: "warning", v: 1, kind: "undeclared-capability", ...access }).catch(() => undefined);
    },
  });
  const hooks: unknown = await factory(host);
  if (!isServiceDecl(manifest)) return runCommand(context, manifest, hooks, process);
  const run = serviceRun(hooks, Object.keys(manifest.expose));
  await runService({
    linux: context, endpoints: manifest.expose, leftovers: leftoverCheck(manifest.process.exclusive === "workspace", moduleReach(manifest.requires.host)), maxClients: manifest.limits?.clients ?? DEFAULT_CLIENTS, run, lifecycle, log,
    ready: async info => {
      const current = await context.process.info();
      await writeLine(context, context.stdout, { oxidevm: "ready", v: 1, pid: current.pid, info });
    },
  });
  return 0;
}

/**
 * The module's network (engine ADR 0029, N-3): `host.net` and the `fetch`/`WebSocket` globals on the process's own VM
 * sockets for a module with a reach, "network not declared" globals for one without, and the browser's other network
 * APIs removed either way. Installed before the adapter is evaluated, so module code never sees the browser's own.
 */
function moduleNetwork(context: RunnerContext, manifest: ResolvedManifest, signal: AbortSignal, report: { readonly refused: (destination: ReachRefusal) => void; readonly direct: (attempt: DirectAttempt) => void }): ModuleNetwork | undefined {
  const { network } = context;
  if (network === undefined) return undefined;
  const created = createModuleNetwork({
    ports: network.ports, reach: moduleReach(manifest.requires.host), signal, refused: report.refused,
    ...(network.tls === undefined ? {} : { tls: network.tls }), ...(network.local === undefined ? {} : { local: network.local }),
  });
  installNetworkGlobals(network.scope, created, report.direct);
  return created;
}

/** Network warnings one run writes at most. */
const MAX_NETWORK_WARNINGS = 16;

/** Turns anything thrown into the exit status and error report the consumer sees. */
function classify(error: unknown, undeclared: ReadonlyMap<string, UndeclaredAccess>): { readonly status: number; readonly report: RunnerReport } {
  if (error instanceof ModuleFailure) return { status: error.status, report: { kind: error.kind, message: error.message, ...(error.items.length === 0 ? {} : { items: error.items }) } };
  const message = error instanceof Error ? error.message : "The module failed";
  const stack = error instanceof Error && error.stack !== undefined ? error.stack.slice(0, MAX_STACK) : undefined;
  const reached = [...new Set([...undeclared.values()].flatMap(access => access.capabilities))];
  const fault = error instanceof AdapterShapeError ? error.fault : reached.length > 0 ? "undeclared-capability" : "thrown";
  return { status: MODULE_EXIT.adapter, report: { kind: "adapter", fault, message, ...(fault === "undeclared-capability" ? { capabilities: reached } : {}), ...(stack === undefined ? {} : { stack }) } };
}

/**
 * Runs one module to completion and returns the exit status for the runner's bootstrap: the adapter's own status (0-119)
 * or one of the runner statuses in `MODULE_EXIT`. Nothing thrown escapes, because an uncaught error would reach the
 * consumer as the engine's reserved status 125. `launch` is what the start message carried: the description and the
 * verified copies of `spawnModule`'s start or of a module command (engine ADR 0027 and ADR 0028). A failure is a JSON record on standard error
 * for an application, and one readable line for a program in the VM that ran a command.
 */
export async function runModule(context: RunnerContext, launch: RunnerLaunch | undefined): Promise<number> {
  const lifecycle = new AbortController(), undeclared = new Map<string, UndeclaredAccess>(), signals = new RunnerSignals(context.signals);
  let artifacts: VerifiedArtifacts | undefined;
  try {
    if (launch === undefined) throw new ModuleFailure("launch", "The module runner started without its launch");
    const info = await context.process.info(), process = { start: runnerStart(launch, info.args), info };
    let descriptor: LaunchDescriptor;
    try { descriptor = parseLaunchArgument(process.start.descriptor); }
    catch (error: unknown) { throw new ModuleFailure("launch", error instanceof VMError ? error.message : "The launch descriptor is invalid"); }
    // Only a command module runs as a program; its files were checked when its commands were turned on.
    if (process.start.invocation.kind === "command" && isServiceDecl(descriptor.manifest)) throw new ModuleFailure("launch", `${descriptor.manifest.id} is a service and runs no commands`);
    artifacts = preverifiedArtifacts(descriptor, process.start.copies, context.readBlobSync);
    const run: Run = { process, artifacts, lifecycle, undeclared, signals };
    // An exclusive service's workspace lease was taken by the Userspace worker before this process existed (ADR 0028).
    return await start(context, descriptor, run);
  } catch (error: unknown) {
    const { status, report } = classify(error, undeclared);
    const written = launch?.kind === "module-command"
      ? context.files.writeAll(context.stderr, encoder.encode(failureLine(launch.invocation.name, report)))
      : writeLine(context, context.stderr, { oxidevm: "error", v: 1, ...report });
    await written.catch(() => undefined);
    return status;
  } finally {
    // A signal during the rest of the exit has its default action again.
    await signals.close();
    artifacts?.close();
    lifecycle.abort();
  }
}
