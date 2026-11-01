import { VMError } from "../../runtime/errors.js";
import { MODULE_EXIT } from "../exit-codes.js";
import type { CommandIO } from "../define.js";
import type { ResolvedManifest } from "../manifest-types.js";
import { isServiceDecl } from "../manifest.js";
import { resolveOptions } from "../options.js";
import { createArtifacts, IntegrityError, type Fetcher } from "./artifacts.js";
import { parseLaunchArgument, type LaunchDescriptor } from "./descriptor.js";
import { ModuleFailure } from "./failure.js";
import { writeGuestFiles } from "./guest-files.js";
import { AdapterShapeError, commandRun, serviceRun } from "./hooks.js";
import { buildHost, type LinuxParts, type UndeclaredAccess } from "./host.js";
import { missingPrerequisites, type BrowserProbe } from "./prerequisites.js";
import { DEFAULT_CLIENTS, runService } from "./service.js";

/** Everything the runner touches outside the Linux process: injected so tests can fake the browser. */
export interface RunnerContext extends LinuxParts {
  readonly fetch: Fetcher;
  /** `navigator.locks`; absent where Web Locks are unavailable. */
  readonly locks: Pick<LockManager, "request"> | undefined;
  readonly browser: BrowserProbe;
  /** Evaluates a verified adapter bundle as an ES module and returns its namespace. */
  readonly importAdapter: (bytes: Uint8Array<ArrayBuffer>) => Promise<unknown>;
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

async function runCommand(context: RunnerContext, manifest: ResolvedManifest, hooks: unknown, args: readonly string[]): Promise<number> {
  const run = commandRun(hooks);
  const info = await context.process.info();
  const io: CommandIO = { args, env: parseEnvironment(info.environment), cwd: info.cwd, stdin: context.stdin, stdout: context.stdout, stderr: context.stderr };
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

async function start(context: RunnerContext, descriptor: LaunchDescriptor, args: readonly string[], lifecycle: AbortController, undeclared: Map<string, UndeclaredAccess>): Promise<number> {
  const { manifest } = descriptor;
  let options;
  try { options = resolveOptions(manifest.options, descriptor.options); }
  catch (error: unknown) { throw new ModuleFailure("launch", error instanceof Error ? error.message : "The options are invalid"); }
  const missing = await missingPrerequisites(manifest, context.browser, context.files);
  if (missing.length > 0) throw new ModuleFailure("prerequisite", `Missing: ${missing.join(", ")}`, missing);
  const artifacts = createArtifacts(descriptor, context.fetch, lifecycle.signal);
  // Everything the release pins is checked before the adapter's first line runs: the adapter, then every other file.
  const adapter = await artifacts.adapter();
  await artifacts.verifyAll();
  await writeGuestFiles(context.files, manifest, artifacts);
  const factory = adapterFactory(await context.importAdapter(adapter));
  const { host, log } = buildHost({
    linux: context, capabilities: manifest.requires.host, options, artifacts, signal: lifecycle.signal,
    // Reaching for an undeclared member is reported once per member and remembered for the fault report.
    undeclared: access => {
      if (undeclared.has(access.member)) return;
      undeclared.set(access.member, access);
      void writeLine(context, context.stderr, { oxidevm: "warning", v: 1, kind: "undeclared-capability", ...access }).catch(() => undefined);
    },
  });
  const hooks: unknown = await factory(host);
  if (!isServiceDecl(manifest)) return runCommand(context, manifest, hooks, args);
  const run = serviceRun(hooks, Object.keys(manifest.expose));
  await runService({
    linux: context, endpoints: manifest.expose, maxClients: manifest.limits?.clients ?? DEFAULT_CLIENTS, run, lifecycle, log,
    ready: async info => {
      const process = await context.process.info();
      await writeLine(context, context.stdout, { oxidevm: "ready", v: 1, pid: process.pid, info });
    },
  });
  return 0;
}

/** Holds the workspace lock for exclusive services and reports `busy` when another process has it. */
async function withExclusiveLock(context: RunnerContext, descriptor: LaunchDescriptor, run: () => Promise<number>): Promise<number> {
  const { manifest } = descriptor;
  if (!isServiceDecl(manifest) || manifest.process.exclusive !== "workspace") return run();
  if (descriptor.workspaceId === undefined) throw new ModuleFailure("launch", "An exclusive service needs a workspaceId");
  if (context.locks === undefined) throw new ModuleFailure("prerequisite", "Missing: browser feature web-locks", ["browser feature web-locks"]);
  return context.locks.request(`oxidevm-module:${descriptor.workspaceId}:${manifest.id}`, { ifAvailable: true }, async lock => {
    if (lock === null) throw new ModuleFailure("busy", `${manifest.id} is already running in this workspace`);
    return run();
  });
}

/** Turns anything thrown into the exit status and error report the consumer sees. */
function classify(error: unknown, undeclared: ReadonlyMap<string, UndeclaredAccess>): { readonly status: number; readonly report: Readonly<Record<string, unknown>> } {
  if (error instanceof ModuleFailure) return { status: error.status, report: { kind: error.kind, message: error.message, ...(error.items.length === 0 ? {} : { items: error.items }) } };
  if (error instanceof IntegrityError) return { status: MODULE_EXIT.integrity, report: { kind: "integrity", message: error.message } };
  const message = error instanceof Error ? error.message : "The module failed";
  const stack = error instanceof Error && error.stack !== undefined ? error.stack.slice(0, MAX_STACK) : undefined;
  const reached = [...new Set([...undeclared.values()].flatMap(access => access.capabilities))];
  const fault = error instanceof AdapterShapeError ? error.fault : reached.length > 0 ? "undeclared-capability" : "thrown";
  return { status: MODULE_EXIT.adapter, report: { kind: "adapter", fault, message, ...(fault === "undeclared-capability" ? { capabilities: reached } : {}), ...(stack === undefined ? {} : { stack }) } };
}

/**
 * Runs one module to completion and returns the exit status for `serveOwnedProcess`: the adapter's own
 * status (0-119) or one of the runner statuses in `MODULE_EXIT`. Nothing thrown escapes, because an
 * uncaught error would reach the consumer as the engine's reserved status 125.
 */
export async function runModule(context: RunnerContext): Promise<number> {
  const lifecycle = new AbortController(), undeclared = new Map<string, UndeclaredAccess>();
  try {
    const info = await context.process.info();
    let descriptor: LaunchDescriptor;
    try { descriptor = parseLaunchArgument(info.args[0]); }
    catch (error: unknown) { throw new ModuleFailure("launch", error instanceof VMError ? error.message : "The launch descriptor is invalid"); }
    return await withExclusiveLock(context, descriptor, () => start(context, descriptor, info.args.slice(1), lifecycle, undeclared));
  } catch (error: unknown) {
    const { status, report } = classify(error, undeclared);
    await writeLine(context, context.stderr, { oxidevm: "error", v: 1, ...report }).catch(() => undefined);
    return status;
  } finally {
    lifecycle.abort();
  }
}
