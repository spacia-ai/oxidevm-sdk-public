import type { ExecResult, ExecSpec, ProcessExit, ProcessHandle, TerminalHandle } from "./contracts.js";
import type { ProcessHandle as RuntimeProcess } from "./runtime/vm-types.js";
import { GuestProcessTransport } from "./runtime/guest-process.js";
import { knownLinuxSignal } from "./runtime/process-signals.js";
import { VMError, withCleanupFailure } from "./runtime/errors.js";
import { decodeProcessId } from "./values.js";

export function adaptProcess(process: RuntimeProcess, terminal: true): TerminalHandle;
export function adaptProcess(process: RuntimeProcess, terminal: false): ProcessHandle;
export function adaptProcess(process: RuntimeProcess, terminal: boolean): ProcessHandle | TerminalHandle;
export function adaptProcess(process: RuntimeProcess, terminal: boolean): ProcessHandle | TerminalHandle {
  if (!(process instanceof GuestProcessTransport)) throw new VMError("PROTOCOL_ERROR", "guest process handle has no transport identity");
  const common = {
    ...(process.snapshotKey===undefined?{}:{snapshotKey:process.snapshotKey}),
    pid: decodeProcessId(process.pid),
    stdin: process.stdin,
    exit: process.termination.then((exit): ProcessExit => {
      if (exit.kind === "exit") return { kind: "exited", code: exit.code };
      return { kind: "signaled", signal: knownLinuxSignal(exit.signal), signalNumber: exit.signal };
    }),
    kill: (signal: Parameters<ProcessHandle["kill"]>[0] = "SIGTERM", options?: Parameters<ProcessHandle["kill"]>[1]) => process.sendSignal(signal, options?.scope ?? "process"),
  };
  if (!terminal) return { ...common, kind: "process", stdout: process.stdout, stderr: process.stderr };
  return { ...common, kind: "terminal", output: terminalOutput(process.stdout, process.stderr), resize: size => process.resize(size), interrupt: () => process.interrupt() };
}

/** Drain transport-owned pipes; cancellation terminates and awaits the admitted group. */
export async function execProcess(process: ProcessHandle, spec: ExecSpec): Promise<ExecResult> {
  const limit = spec.maxOutputBytes ?? 1024 ** 2;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "maxOutputBytes must be an integer from 1 to 67108864");
  const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = [];
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const cleanupFailure = Promise.withResolvers<never>();
  let bytes = 0; let failure: unknown; const state = { failed: false }; let cleanup: Promise<void> | undefined; let exited = false;
  const exit = process.exit.then(value => { exited = true; return value; });
  const stop = (reason: unknown) => {
    if (state.failed) return;
    state.failed = true; failure = reason;
    cleanup = (exited ? Promise.resolve() : Promise.resolve().then(() => process.kill("SIGKILL", { scope: "process-group" }))).catch(async (error: unknown) => {
      // No native exit receipt can be required after losing the process owner. Release
      // local stream ownership and report that group retirement could not be proved.
      await Promise.allSettled([...readers].map(reader => reader.cancel(reason)));
      stdinWriter?.releaseLock();
      const uncertain = withCleanupFailure(reason, error);
      cleanupFailure.reject(uncertain);
      throw uncertain;
    });
    void cleanup.catch(() => {});
  };
  const abort = () => stop(new VMError("ABORTED", "command cancelled"));
  spec.signal?.addEventListener("abort", abort, { once: true });
  if (spec.signal?.aborted === true) abort();
  const drain = async (stream: ReadableStream<Uint8Array>, output: Uint8Array[]) => {
    const reader = stream.getReader();
    readers.add(reader);
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) return;
        bytes += value.value.byteLength;
        if (bytes > limit) stop(new VMError("QUOTA_EXCEEDED", "command exceeded its combined output limit", { maxOutputBytes: limit }));
        if (!state.failed) output.push(value.value);
      }
    } catch (error) { stop(error); }
    finally { readers.delete(reader); reader.releaseLock(); }
  };
  const send = async () => {
    const writer = process.stdin.getWriter();
    stdinWriter = writer;
    try {
      if (!state.failed && spec.stdin !== undefined) await writer.write(spec.stdin.slice());
      await writer.close();
    } catch (error) { if (!exited) stop(error); }
    finally { stdinWriter = undefined; writer.releaseLock(); }
  };
  try {
    const [termination] = await Promise.race([Promise.all([exit, drain(process.stdout, stdout), drain(process.stderr, stderr), send()]), cleanupFailure.promise]);
    await cleanup;
    if (state.failed) throw failure instanceof Error ? failure : new VMError("VM_FAULT", "command failed");
    return { stdout: concatenate(stdout), stderr: concatenate(stderr), exit: termination };
  } finally { spec.signal?.removeEventListener("abort", abort); }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function terminalOutput(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const bridge = new TransformStream<Uint8Array, Uint8Array>();
  const writer = bridge.writable.getWriter();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      for (;;) { const next = await reader.read(); if (next.done) return; await writer.write(next.value); }
    } catch (error) { await reader.cancel(error); throw error; }
    finally { reader.releaseLock(); }
  };
  void Promise.all([pump(stdout), pump(stderr)]).then(() => writer.close(), (error: unknown) => writer.abort(error)).finally(() => writer.releaseLock()).catch(() => {});
  return bridge.readable;
}
