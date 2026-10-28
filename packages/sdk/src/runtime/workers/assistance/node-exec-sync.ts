import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import { decodeAssistanceOperation } from "../../protocol/assistance.js";
import { knownLinuxSignal } from "../../process-signals.js";
import { nodeEnvironment } from "./node-children.js";
import type { CapturedProcess, ProcessRuntimeIO } from "./process-io.js";

export type SynchronousRuntime = { readonly kind: "node" } | { readonly kind: "bun"; readonly initialPath: string };
export const BUN_DEFAULT_SEARCH_PATH = "/usr/local/bin:/bin:/usr/bin";
type Capture = NonNullable<ProcessRuntimeIO["captureSync"]>;
type CaptureOutcome = { readonly kind: "captured"; readonly result: CapturedProcess } | { readonly kind: "launch-error"; readonly failure: ReturnType<typeof launchFailure> };
const bunLaunchDescriptions: Readonly<Record<string, string>> = { ENOENT: "no such file or directory", EACCES: "permission denied", ENOTDIR: "not a directory", ELOOP: "too many symbolic links encountered" };
class SystemError extends Error {}
Object.defineProperty(SystemError, "name", { value: "SystemError", configurable: true });
Object.defineProperty(SystemError.prototype, "name", { value: "SystemError", writable: true, configurable: true });

function prepare(file: unknown, args: unknown, options: unknown, inherited: Readonly<Record<string, string>>) {
  if (!Array.isArray(args)) { options = args ?? options; args = []; }
  if (typeof file !== "string" || !Array.isArray(args)) throw new TypeError("Invalid executable or arguments");
  const arguments_: string[] = args.map((arg: unknown) => { if (typeof arg !== "string") throw new TypeError("Invalid executable argument"); return arg; });
  if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) throw new TypeError("Invalid execution options");
  const record = typeof options === "object" && options !== null ? options : {};
  if (Object.keys(record).some(key => !["cwd", "env", "input", "maxBuffer", "encoding", "windowsHide", "stdio"].includes(key))) throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported synchronous child execution options");
  const stdio: unknown = Reflect.get(record, "stdio");
  if (stdio !== undefined && stdio !== "pipe" && !(Array.isArray(stdio) && stdio.length === 3 && Array.from<unknown>(stdio).every(value => value === "pipe"))) {
    throw new VMError("FEATURE_NOT_AVAILABLE", "Only piped synchronous child stdio is qualified");
  }
  const maximum: unknown = Reflect.get(record, "maxBuffer");
  const maxBuffer = maximum === undefined ? 1024 * 1024 : maximum;
  if (typeof maxBuffer !== "number" || !Number.isSafeInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > 64 * 1024 * 1024) throw new RangeError("Synchronous child maxBuffer must be at most 64 MiB");
  // Node uses zero for unbounded capture; this transport requires a finite memory limit.
  if (maxBuffer === 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Unbounded synchronous child output is not supported");
  const encoding: unknown = Reflect.get(record, "encoding");
  if (encoding !== undefined && encoding !== null && encoding !== "buffer" && encoding !== "utf8" && encoding !== "utf-8") throw new VMError("FEATURE_NOT_AVAILABLE", "Only UTF-8 and binary synchronous child output are qualified");
  const hidden: unknown = Reflect.get(record, "windowsHide");
  if (hidden !== undefined && typeof hidden !== "boolean") throw new TypeError("Invalid windowsHide option");
  const input: unknown = Reflect.get(record, "input");
  const bytes = input === undefined ? new Uint8Array() : typeof input === "string" ? new TextEncoder().encode(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice() : undefined;
  if (bytes === undefined || bytes.byteLength > 16 * 1024 * 1024) throw new RangeError("Synchronous child input must be at most 16 MiB");
  const cwd: unknown = Reflect.get(record, "cwd"), env: unknown = Reflect.get(record, "env");
  const operation = decodeAssistanceOperation({ kind: "spawn", command: file, args: arguments_, cwd: cwd ?? ".", env: nodeEnvironment(env, inherited) });
  if (operation.kind !== "spawn") throw new VMError("PROTOCOL_ERROR", "Invalid synchronous child request");
  return { file, arguments_, operation, bytes, maxBuffer, encoding, forwardStderr: stdio === undefined, explicitEnvironment: env !== undefined && env !== null };
}

function output(result: CapturedProcess, encoding: unknown) {
  const encode = (bytes: Uint8Array): Buffer | string => encoding === "utf8" || encoding === "utf-8" ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
  const stdout = encode(result.stdout), stderr = encode(result.stderr), streams: [null, Buffer | string, Buffer | string] = [null, stdout, stderr];
  return { status: result.status, signal: result.signal === null ? null : knownLinuxSignal(result.signal), output: streams, pid: result.pid, stdout, stderr };
}

function spawnError(file: string, args: readonly string[], code: string, errno: number, runtime: SynchronousRuntime = { kind: "node" }, stage: "spawn" | "path-search" | "max-buffer" = "spawn"): Error {
  let message = `spawnSync ${file} ${code}`;
  if (runtime.kind === "bun" && stage === "max-buffer") message += " (stdout or stderr buffer reached maxBuffer size limit)";
  else if (runtime.kind === "bun" && stage === "path-search" && code === "ENOENT") message = `Executable not found in $PATH: "${file}"`;
  else if (runtime.kind === "bun") {
    const detail = bunLaunchDescriptions[code];
    if (detail === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Bun synchronous launch failure is not qualified", { code, errno });
    message = `${code}: ${detail}, posix_spawn '${file}'`;
  }
  const error = runtime.kind === "bun" && stage === "max-buffer" ? new SystemError(message) : new Error(message);
  return Object.assign(error, { errno, code, syscall: `spawnSync ${file}`, path: file, spawnargs: [...args] });
}

function launchFailure(request: ReturnType<typeof prepare>, runtime: SynchronousRuntime, code: string, errno: number, stage: "spawn" | "path-search") {
  const error = spawnError(request.file, request.arguments_, code, errno, runtime, stage);
  return runtime.kind === "bun"
    ? { error, status: undefined, signal: null, output: [null, null, null], pid: undefined, stdout: null, stderr: null }
    : { error, status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined };
}

function captureChild(capture: Capture, request: ReturnType<typeof prepare>, runtime: SynchronousRuntime): CaptureOutcome {
  try {
    const explicitPath = request.operation.env["PATH"];
    const options: Parameters<Capture>[3] = runtime.kind === "bun" ? { runtime: "bun", ...(!request.file.includes("/")
      ? { path: request.explicitEnvironment ? explicitPath === undefined || explicitPath === "" ? BUN_DEFAULT_SEARCH_PATH : explicitPath : runtime.initialPath } : {}) } : undefined;
    const result = options === undefined ? capture(request.operation, request.bytes, request.maxBuffer) : capture(request.operation, request.bytes, request.maxBuffer, options);
    return { kind: "captured", result };
  }
  catch (error) {
    // Transport and application failures must not masquerade as Linux spawn errors.
    if (!(error instanceof Error)) throw error;
    const errno: unknown = Reflect.get(error, "errno"), code: unknown = Reflect.get(error, "code"), syscall: unknown = Reflect.get(error, "syscall");
    if (syscall !== "spawn" && syscall !== "spawn-path-search" || typeof errno !== "number" || !Number.isInteger(errno) || errno >= 0 || errno < -4095
      || typeof code !== "string" || !/^E[A-Z0-9_]+$/u.test(code)) throw error;
    return { kind: "launch-error", failure: launchFailure(request, runtime, code, errno, syscall === "spawn" ? "spawn" : "path-search") };
  }
}

/** Return child termination and Linux launch failures without turning them into application exceptions. */
export function createSpawnSync(capture: Capture, inherited: Readonly<Record<string, string>>, runtime: SynchronousRuntime = { kind: "node" }) {
  return (file: unknown, args?: unknown, options?: unknown) => {
    const request = prepare(file, args, options, inherited), outcome = captureChild(capture, request, runtime);
    if (outcome.kind === "launch-error") return outcome.failure;
    const result = outcome.result;
    return { ...(result.error === undefined ? {} : { error: spawnError(request.file, request.arguments_, result.error, -105, runtime, "max-buffer") }), ...output(result, request.encoding) };
  };
}

/** Bounded pipe capture uses the native transport. Unsupported options fail before child creation. */
export function createExecFileSync(capture: Capture, inherited: Readonly<Record<string, string>>, stderr?: (bytes: Uint8Array) => void, command?: string, runtime: SynchronousRuntime = { kind: "node" }) {
  return (file: unknown, args?: unknown, options?: unknown): Buffer | string => {
    const request = prepare(file, args, options, inherited);
    const outcome = captureChild(capture, request, runtime);
    if (outcome.kind === "launch-error") {
      const { error, ...detail } = outcome.failure;
      throw Object.assign(error, runtime.kind === "node" ? outcome.failure : detail);
    }
    const result = outcome.result;
    if (request.forwardStderr && result.stderr.byteLength !== 0) stderr?.(result.stderr);
    const formatted = output(result, request.encoding);
    if (result.error !== undefined) {
      const error = spawnError(request.file, request.arguments_, result.error, -105, runtime, "max-buffer");
      throw Object.assign(error, runtime.kind === "node" ? { error, ...formatted } : formatted);
    }
    if (result.status !== 0 || result.signal !== null) {
      const label = command ?? [request.file, ...request.arguments_].join(" ");
      const detail = result.stderr.byteLength === 0 ? "" : `\n${new TextDecoder().decode(result.stderr)}`;
      throw Object.assign(new Error(`Command failed: ${label}${detail}`), {
        pid: formatted.pid, status: formatted.status, signal: formatted.signal, output: formatted.output, stdout: formatted.stdout, stderr: formatted.stderr,
      });
    }
    return formatted.stdout;
  };
}

/** Shell parsing belongs to the real Linux shell, with the same bounded capture and cleanup. */
export function createExecSync(capture: Capture, inherited: Readonly<Record<string, string>>, stderr?: (bytes: Uint8Array) => void, runtime: SynchronousRuntime = { kind: "node" }) {
  return (command: unknown, options?: unknown): Buffer | string => {
    if (typeof command !== "string") throw Object.assign(new TypeError('The "command" argument must be of type string'), { code: "ERR_INVALID_ARG_TYPE" });
    return createExecFileSync(capture, inherited, stderr, command, runtime)("/bin/sh", ["-c", command], options);
  };
}
