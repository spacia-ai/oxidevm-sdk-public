import type { LinuxSignal, PipeJSProcessSpec, ProcessExit, ProcessHandle } from "../contracts.js";
import { VMError, type VMErrorCode } from "../runtime/errors.js";
import { MODULE_EXIT, MODULE_EXIT_REASONS, type ModuleExitReason } from "./exit-codes.js";
import type { ModuleHandle, ModuleProcess, SpawnArgs } from "./handle.js";
import { launchDescriptor } from "./launch-descriptor.js";
import { isServiceDecl } from "./manifest.js";
import type { ModuleDecl, ResolvedManifest } from "./manifest-types.js";
import { encodeLaunchArgument } from "./runner/descriptor.js";
import { settledWithin } from "./runner/failure.js";
import { withModuleFiles } from "./module-supply.js";
import { ownedModules } from "../vm-adapter.js";

/**
 * What `spawnModule` and `enableModuleCommands` need of a VM: a Userspace VM, which has `spawnJS`; a system VM has
 * none, so it does not type-check. Both reach the VM through its private owner record (engine ADR 0027): the runner gets
 * its launch description in its start message, and a VM's module commands live in its Userspace worker, so only a VM
 * `createVM` returned can run a module.
 */
export interface ModuleVM {
  spawnJS(spec: PipeJSProcessSpec): Promise<ProcessHandle>;
}

const DEFAULT_STARTUP_MS = 120_000;
const READY_LINE_BYTES = 64 * 1024;
const STDERR_TAIL_BYTES = 4096;
const STOP_GRACE_MS = 20_000;
const STDERR_SETTLE_MS = 1000;

type Info = Readonly<Record<string, string | number | boolean>>;
interface Failure { readonly code: VMErrorCode; readonly reason: string }

/** How a runner exit status is reported to the consumer. Files are checked before the process exists (ADR 0028). */
function failureFor(exit: ProcessExit): Failure {
  if (exit.kind === "exited") {
    if (exit.code === MODULE_EXIT.prerequisite) return { code: "FEATURE_NOT_AVAILABLE", reason: MODULE_EXIT_REASONS.prerequisite };
    if (exit.code === MODULE_EXIT.busy) return { code: "QUOTA_EXCEEDED", reason: MODULE_EXIT_REASONS.busy };
    const kinds: readonly ModuleExitReason[] = ["launch", "adapter"];
    const kind = kinds.find(candidate => MODULE_EXIT[candidate] === exit.code);
    if (kind !== undefined) return { code: "GUEST_CRASH", reason: MODULE_EXIT_REASONS[kind] };
  }
  return { code: "GUEST_CRASH", reason: MODULE_EXIT_REASONS.adapter };
}

/** The last error record the runner wrote, if any; its message is the best explanation of an early exit. */
function runnerReport(stderr: string): { readonly message: string; readonly items: readonly string[]; readonly reason: string | undefined } | undefined {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "oxidevm") !== "error") continue;
      const message: unknown = Reflect.get(parsed, "message"), items: unknown = Reflect.get(parsed, "items"), reason: unknown = Reflect.get(parsed, "reason");
      return { message: typeof message === "string" ? message : "The module failed", items: Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [], reason: typeof reason === "string" ? reason : undefined };
    } catch { /* not a runner record */ }
  }
  return undefined;
}

function startupError(manifest: ResolvedManifest, exit: ProcessExit, stderr: string): VMError {
  const report = runnerReport(stderr);
  const { code, reason } = failureFor(exit);
  const status = exit.kind === "exited" ? exit.code : -exit.signalNumber;
  const message = report?.message ?? (stderr.trim().slice(-500) || `exit status ${String(status)}`);
  return new VMError(code, `${manifest.id} did not start: ${message}`, { reason, status, ...(report === undefined || report.items.length === 0 ? {} : { missing: report.items }) });
}

/** Reads the first line of a stream, within a size bound, as text; `undefined` when the stream ends first. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return undefined;
      text += decoder.decode(part.value, { stream: true });
      const cut = text.indexOf("\n");
      if (cut >= 0) return text.slice(0, cut);
      if (text.length > READY_LINE_BYTES) throw notReady("is too long");
    }
  } finally {
    // A tee branch's cancel() settles only when its sibling is cancelled too, so it must not be awaited.
    void reader.cancel().catch(() => undefined);
  }
}

/** Keeps the end of a stream while it is being read, so an early exit can be explained. */
function collectTail(stream: ReadableStream<Uint8Array>): { readonly text: () => string; readonly done: Promise<void>; readonly stop: () => Promise<void> } {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let tail = "";
  const pump = (async () => {
    for (;;) {
      const part = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (part.done) return;
      tail = (tail + decoder.decode(part.value, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  })();
  // Not awaited for the same reason as in firstLine; cancelling ends the pending read, so `pump` settles.
  return { text: () => tail, done: pump, stop: async () => { void reader.cancel().catch(() => undefined); await pump; } };
}

/** Stable `detail.reason` for a service whose first output line is not the ready record. */
export const READY_INVALID = "wasm-module-ready";

function notReady(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", `The module's ready line ${message}`, { reason: READY_INVALID });
}

function decodeReady(line: string, pid: number): Info {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw notReady("is not JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw notReady("is not an object");
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "info,oxidevm,pid,v" || Reflect.get(parsed, "oxidevm") !== "ready" || Reflect.get(parsed, "v") !== 1) throw notReady("is not a version 1 ready record");
  if (Reflect.get(parsed, "pid") !== pid) throw notReady("names a different process");
  const info: unknown = Reflect.get(parsed, "info");
  if (typeof info !== "object" || info === null || Array.isArray(info)) throw notReady("has no info object");
  const entries = Object.entries(info).flatMap(([key, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, value] as const] : []);
  if (entries.length !== Object.keys(info).length) throw notReady("has info that is not made of strings, numbers and booleans");
  return Object.fromEntries(entries);
}

async function kill(process: ProcessHandle): Promise<void> {
  await process.kill("SIGKILL").catch(() => undefined);
  await process.exit.catch(() => undefined);
}

interface Started { readonly info: Info; readonly stdout: ReadableStream<Uint8Array>; readonly stderr: ReadableStream<Uint8Array> }

/** Waits for a service's ready line, its early exit, the startup deadline or the caller's cancellation. */
async function awaitReady(process: ProcessHandle, manifest: ResolvedManifest, signal: AbortSignal | undefined): Promise<Started> {
  const [outProbe, stdout] = process.stdout.tee(), [errProbe, stderr] = process.stderr.tee();
  const errors = collectTail(errProbe);
  const startupMs = manifest.limits?.startupMs ?? DEFAULT_STARTUP_MS;
  const cancelled = Promise.withResolvers<never>(), expired = Promise.withResolvers<never>();
  cancelled.promise.catch(() => undefined);
  expired.promise.catch(() => undefined);
  const abort = () => { cancelled.reject(signal?.reason instanceof Error ? signal.reason : new VMError("ABORTED", `Starting ${manifest.id} was cancelled`)); };
  if (signal?.aborted === true) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { expired.reject(new VMError("GUEST_CRASH", `${manifest.id} was not ready within ${String(startupMs)} ms`, { reason: MODULE_EXIT_REASONS.adapter })); }, startupMs);
  // The process has exited, but its last words may still be in the pipe: let standard error finish, briefly.
  const early = process.exit.then(async exit => {
    await settledWithin(errors.done, STDERR_SETTLE_MS);
    throw startupError(manifest, exit, errors.text());
  });
  early.catch(() => undefined);
  try {
    const line = await Promise.race([firstLine(outProbe), early, cancelled.promise, expired.promise]);
    // Output that ends without a ready line means the process is ending: its exit explains why.
    if (line === undefined) return await Promise.race([early, cancelled.promise, expired.promise]);
    return { info: decodeReady(line, process.pid), stdout, stderr };
  } catch (error: unknown) {
    await kill(process);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await errors.stop();
  }
}

/**
 * Starts an installed module in a Userspace VM. A command module returns its process at once; a
 * service module returns once its adapter is listening on every declared endpoint. Every failure to
 * start is a `VMError` with a stable `detail.reason`, and a module that did not start is killed.
 */
export function spawnModule<const M extends ModuleDecl>(vm: ModuleVM, handle: ModuleHandle<M>, ...args: SpawnArgs<M>): Promise<ModuleProcess<M>>;
export async function spawnModule(vm: ModuleVM, handle: ModuleHandle, ...args: readonly unknown[]): Promise<ProcessHandle> {
  // The overload above fixes the argument types for callers; this body decodes them as untrusted input.
  const first = args[0];
  if (first !== undefined && (typeof first !== "object" || first === null)) throw new VMError("INVALID_ARGUMENT", "The spawn options must be an object", { reason: "wasm-module-options" });
  const request: Readonly<Record<string, unknown>> = first === undefined ? {} : Object.fromEntries(Object.entries(first));
  const workspaceId = request["workspaceId"];
  if (workspaceId !== undefined && typeof workspaceId !== "string") throw new VMError("INVALID_ARGUMENT", "workspaceId must be a string", { reason: "wasm-module-options" });
  const descriptor = launchDescriptor(handle, { options: request["options"], workspaceId });
  const commandArgs = request["args"], signal = request["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT", "signal must be an AbortSignal");
  const modules = ownedModules(vm), cancel = signal instanceof AbortSignal ? signal : undefined;
  const spec = {
    args: Array.isArray(commandArgs) ? Array.from<unknown>(commandArgs).map(String) : [],
    ...(typeof request["cwd"] === "string" ? { cwd: request["cwd"] } : {}),
    ...(typeof request["env"] === "object" && request["env"] !== null ? { env: Object.fromEntries(Object.entries(request["env"]).map(([key, value]) => [key, String(value)])) } : {}),
    ...(cancel === undefined ? {} : { signal: cancel }),
  };
  // The launch description travels in the runner's start message, never in argv, where /proc/<pid>/cmdline would show it.
  // The VM's store checks the files it lacks before the process exists (ADR 0028): a file that differs from its pin
  // rejects here, and a later start sends nothing.
  const encoded = encodeLaunchArgument(descriptor);
  let process: ProcessHandle;
  try {
    process = await withModuleFiles(descriptor, modules, files => modules.spawn(spec, { descriptor: encoded, files }), cancel);
  } catch (error: unknown) {
    // A cancellation while the page read a file started nothing.
    if (cancel?.aborted === true && !(error instanceof VMError && error.code === "ABORTED")) throw cancel.reason instanceof Error ? cancel.reason : new VMError("ABORTED", `Starting ${descriptor.manifest.id} was cancelled`);
    throw error;
  }
  const { manifest } = descriptor;
  if (!isServiceDecl(manifest)) return process;
  const started = await awaitReady(process, manifest, signal instanceof AbortSignal ? signal : undefined);
  const running = {
    kind: "process" as const, pid: process.pid, stdin: process.stdin, stdout: started.stdout, stderr: started.stderr, exit: process.exit,
    kill: (killSignal?: LinuxSignal, options?: { readonly scope?: "process" | "process-group" }) => process.kill(killSignal, options),
    ...(process.snapshotKey === undefined ? {} : { snapshotKey: process.snapshotKey }),
    endpoints: manifest.expose, info: started.info,
  };
  return running;
}

/**
 * Stops a module gracefully: closing its standard input asks a service to drain and exit. If it has not
 * exited within `graceMs` (default 20 s: five to drain, ten to close, and margin) it is killed.
 */
export async function stopModule(process: ProcessHandle, options: { readonly graceMs?: number } = {}): Promise<ProcessExit> {
  await process.stdin.close().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">(resolve => { timer = setTimeout(() => { resolve("expired"); }, options.graceMs ?? STOP_GRACE_MS); });
  try {
    const outcome = await Promise.race([process.exit, expired]);
    if (outcome !== "expired") return outcome;
  } finally {
    clearTimeout(timer);
  }
  await process.kill("SIGKILL").catch(() => undefined);
  return process.exit;
}
