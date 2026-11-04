import { WASI, type WasiErrno } from "../errno.js";
import { linuxErrno } from "../../errno.js";
import type { NativeRunResult, ProcessSyncHost } from "../host.js";
import type { GuestMemory } from "../memory.js";
import { WasiError, type WasiContext } from "../context.js";
import type { Handles } from "./handles.js";

type ImportFunction = (...args: never[]) => number;
export const COMMAND_FUNCTIONS = ["command_run", "result_status", "result_read", "result_close"] as const;

/** The bounds of one native run (matching the oxidevm-bridge crate). */
export const NATIVE = { maxArgs: 63, maxInput: 5 * 1024 * 1024, maxOutput: 1024 * 1024, maxTimeoutMs: 180_000, retainedBytes: 8 * 1024 * 1024, maxRequest: 6 * 1024 * 1024 } as const;
const LINUX_ETIMEDOUT = 110, LINUX_E2BIG = 7;

/** Reads the command request record exactly; any shortfall, excess or broken bound is INVAL before anything runs. */
export function decodeRequest(bytes: Uint8Array): Parameters<ProcessSyncHost["runSync"]>[0] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 0;
  const fail = (): never => { throw new WasiError(WASI.inval); };
  const u32 = (): number => { if (at + 4 > bytes.byteLength) fail(); const value = view.getUint32(at, true); at += 4; return value; };
  const u8 = (): number => { if (at + 1 > bytes.byteLength) fail(); const value = view.getUint8(at); at += 1; return value; };
  const blob = (max: number): Uint8Array => { const length = u32(); if (length > max || at + length > bytes.byteLength) fail(); const value = bytes.slice(at, at + length); at += length; return value; };
  const text = (max: number): string => { const value = blob(max); if (value.includes(0)) fail(); try { return decoder.decode(value); } catch { return fail(); } };
  const list = (max: number): string[] => { const count = u32(); if (count > max) fail(); return Array.from({ length: count }, () => text(128 * 1024)); };
  const command = text(4095);
  const args = list(NATIVE.maxArgs);
  const cwd = u8() === 1 ? text(4095) : undefined;
  const envPresent = u8();
  const envList = envPresent === 1 ? list(4096) : undefined;
  const input = blob(NATIVE.maxInput);
  const timeoutMs = u32(), stdoutLimit = u32(), stderrLimit = u32();
  if (at !== bytes.byteLength || !command.startsWith("/") || timeoutMs < 1 || timeoutMs > NATIVE.maxTimeoutMs || stdoutLimit > NATIVE.maxOutput || stderrLimit > NATIVE.maxOutput) fail();
  let env: Record<string, string> | undefined;
  if (envList !== undefined) {
    env = {};
    for (const entry of envList) { const split = entry.indexOf("="); if (split <= 0) fail(); env[entry.slice(0, split)] = entry.slice(split + 1); }
  }
  return { command, args, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), input, timeoutMs, stdoutLimit, stderrLimit };
}

/**
 * The native-process part of `oxidevm_bridge_v1`. Each finished child is retained behind a per-run handle until the
 * program closes it, within the run's descriptor count and an 8 MiB budget, so the host never re-runs a command to
 * learn its size and a program cannot grow host memory without bound.
 */
export function bridgeCommand(context: WasiContext, process: ProcessSyncHost | undefined, memory: () => GuestMemory, results: Handles<NativeRunResult>): Readonly<Record<(typeof COMMAND_FUNCTIONS)[number], ImportFunction>> {
  let retained = 0;
  const get = (handle: number): NativeRunResult => results.get(handle);
  const native = (body: () => void): WasiErrno => context.guarded(() => {
    try { body(); }
    catch (error) {
      const linux = linuxErrno(error);
      if (linux === LINUX_ETIMEDOUT) throw new WasiError(WASI.timedout);
      if (linux === LINUX_E2BIG) throw new WasiError(WASI.toobig);
      throw error;
    }
  });
  return {
    command_run: (pointer: number, length: number, outHandle: number, outSizes: number) => native(() => {
      if (process === undefined) throw new WasiError(WASI.nosys);
      const guest = memory();
      if (length > NATIVE.maxRequest) throw new WasiError(WASI.inval);
      guest.check(outHandle, 4); guest.check(outSizes, 8);
      const spec = decodeRequest(guest.read(pointer, length));
      if (retained + spec.stdoutLimit + spec.stderrLimit > NATIVE.retainedBytes) throw new WasiError(WASI.nomem);
      const result = process.runSync(spec);
      if (result.stdout.byteLength > spec.stdoutLimit || result.stderr.byteLength > spec.stderrLimit) throw new RangeError("the host returned more output than the limit");
      const handle = results.add(result);
      retained += result.stdout.byteLength + result.stderr.byteLength;
      memory().setU32(outHandle, handle);
      memory().setU32(outSizes, result.stdout.byteLength); memory().setU32(outSizes + 4, result.stderr.byteLength);
    }),
    result_status: (handle: number, out: number) => context.guarded(() => {
      const { pid, exit } = get(handle), guest = memory();
      guest.check(out, 12);
      guest.setU32(out, pid); guest.setU32(out + 4, exit.kind === "exited" ? 0 : 1); guest.setU32(out + 8, exit.kind === "exited" ? exit.code : exit.signalNumber);
    }),
    result_read: (handle: number, stream: number, offset: number, buffer: number, length: number, out: number) => context.guarded(() => {
      const result = get(handle);
      const bytes = stream === 1 ? result.stdout : stream === 2 ? result.stderr : undefined;
      if (bytes === undefined || offset > bytes.byteLength) throw new WasiError(WASI.inval);
      const guest = memory();
      guest.check(buffer, length); guest.check(out, 4);
      const chunk = bytes.subarray(offset, offset + length);
      guest.write(buffer, chunk); guest.setU32(out, chunk.byteLength);
    }),
    result_close: (handle: number) => context.guarded(() => {
      const result = results.remove(handle);
      retained -= result.stdout.byteLength + result.stderr.byteLength;
    }),
  };
}
