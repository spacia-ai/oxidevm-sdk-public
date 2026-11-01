import type { FileDescriptor, LinuxFiles, LinuxProcesses } from "../../js-process-types.js";
import { VMError } from "../../runtime/errors.js";

/** The host members `runNative` uses; an adapter has them when it declares `files.async` and `process.spawn`. */
export interface NativeRunHost {
  readonly process: Pick<LinuxProcesses, "spawn" | "wait" | "signal">;
  readonly files: Pick<LinuxFiles, "read" | "writeAll" | "close">;
}

export interface NativeRunRequest {
  /** The absolute executable path, then its arguments (1 to 64 strings without NUL characters). */
  readonly argv: readonly string[];
  readonly input?: string;
  /** From 1 ms to 180 s; the child is killed when it elapses. */
  readonly timeoutMs: number;
  readonly cwd?: string;
  /** Cancels the run and kills the child. */
  readonly signal?: AbortSignal;
  /** Per-stream output cap in bytes; defaults to 1 MiB. */
  readonly maxOutputBytes?: number;
}

export interface NativeRunResult {
  readonly pid: number;
  /** The exit code, or minus the signal number when the child was killed by a signal. */
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const MAX_ARGUMENTS = 64;
export const MAX_INPUT_BYTES = 5 * 1024 ** 2;
export const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_BYTES = 1024 ** 2;
const READ_CHUNK = 65_536;
const SIGKILL = 9;

function invalid(message: string): never {
  throw new VMError("INVALID_ARGUMENT", message);
}

function validate(request: NativeRunRequest): { readonly command: string; readonly args: readonly string[] } {
  const { argv, input = "", timeoutMs } = request;
  const [command, ...args] = argv;
  if (command === undefined || argv.length > MAX_ARGUMENTS || argv.some(value => value.includes("\0"))) invalid(`A native command takes 1 to ${String(MAX_ARGUMENTS)} arguments without NUL characters`);
  if (!command.startsWith("/")) invalid("Use an absolute Linux executable path");
  if (new TextEncoder().encode(input).length > MAX_INPUT_BYTES) invalid("Native text input exceeds 5 MiB");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) invalid("A native timeout must be between 1 ms and 180 seconds");
  return { command, args };
}

/**
 * Runs a native Linux program with piped standard streams, a deadline and bounded output. Every
 * argument is validated before the child is spawned, and the child is killed and reaped on timeout,
 * cancellation or failure.
 */
export async function runNative(host: NativeRunHost, request: NativeRunRequest): Promise<NativeRunResult> {
  const { command, args } = validate(request);
  request.signal?.throwIfAborted();
  const { files, process } = host;
  const limit = request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const controller = new AbortController();
  const owned = new Set<FileDescriptor>();
  const tasks: Promise<unknown>[] = [];
  const timer = setTimeout(() => { controller.abort(new VMError("ABORTED", "The native command timed out")); }, request.timeoutMs);
  const relay = () => { controller.abort(request.signal?.reason); };
  request.signal?.addEventListener("abort", relay, { once: true });

  async function close(fd: FileDescriptor): Promise<void> {
    if (owned.delete(fd)) await files.close(fd);
  }
  async function drain(fd: FileDescriptor, name: string): Promise<string> {
    const decoder = new TextDecoder();
    let output = "", size = 0;
    try {
      for (;;) {
        const bytes = await files.read(fd, READ_CHUNK, { signal: controller.signal });
        if (bytes.length === 0) return output + decoder.decode();
        size += bytes.length;
        if (size > limit) throw new VMError("QUOTA_EXCEEDED", `Native ${name} exceeds the ${String(limit)} byte output limit`);
        output += decoder.decode(bytes, { stream: true });
      }
    } finally {
      await close(fd);
    }
  }

  try {
    const child = await process.spawn({ command, args, cwd: request.cwd ?? "/workspace", stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } }, { signal: controller.signal });
    for (const fd of [child.stdin, child.stdout, child.stderr]) if (fd !== null) owned.add(fd);
    const terminate = () => { void process.signal(child.pid, SIGKILL).catch(() => undefined); };
    controller.signal.addEventListener("abort", terminate, { once: true });
    if (controller.signal.aborted) terminate();
    const exit = process.wait(child.pid);
    tasks.push(exit);
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new VMError("PROTOCOL_ERROR", "The native command did not provide its requested pipes");
    const write = (async () => {
      try { await files.writeAll(stdin, new TextEncoder().encode(request.input ?? "")); } finally { await close(stdin); }
    })();
    const out = drain(stdout, "stdout"), err = drain(stderr, "stderr");
    tasks.push(write, out, err);
    const [status, , stdoutText, stderrText] = await Promise.all([exit, write, out, err]);
    controller.signal.throwIfAborted();
    return { pid: child.pid, returncode: status.kind === "exited" ? status.code : -status.signalNumber, stdout: stdoutText, stderr: stderrText };
  } catch (error: unknown) {
    controller.abort(error);
    await Promise.allSettled(tasks);
    throw controller.signal.reason;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", relay);
    await Promise.allSettled(Array.from(owned, close));
  }
}
