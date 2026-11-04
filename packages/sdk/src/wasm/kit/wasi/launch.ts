import { LIMITS } from "./limits.js";
import type { GuestMemory } from "./memory.js";
import { WASI } from "./errno.js";

/** Thrown by proc_exit to unwind the guest; the command maps `code` to its status. */
export class ProcExit extends Error {
  override readonly name = "ProcExit";
  constructor(readonly code: number) { super(`proc_exit(${String(code)})`); }
}

/** The launch values a program receives: each string already NUL-terminated UTF-8, within LIMITS.launchBytes. */
export interface Launch { readonly argv: readonly Uint8Array[]; readonly environ: readonly Uint8Array[] }

/** A launch the profile refuses before guest entry (too large, or a string with NUL). */
export class LaunchError extends Error {
  override readonly name = "LaunchError";
}

export function encodeLaunch(argv: readonly string[], env: Readonly<Record<string, string>>): Launch {
  const encoder = new TextEncoder();
  const encode = (label: string, values: readonly string[]): readonly Uint8Array[] => {
    let total = 0;
    return values.map(value => {
      if (value.includes("\0")) throw new LaunchError(`${label} contains a NUL character`);
      const bytes = encoder.encode(`${value}\0`);
      total += bytes.byteLength;
      if (total > LIMITS.launchBytes) throw new LaunchError(`${label} exceeds ${String(LIMITS.launchBytes)} bytes`);
      return bytes;
    });
  };
  return { argv: encode("argv", argv), environ: encode("the environment", Object.entries(env).map(([key, value]) => `${key}=${value}`)) };
}

type ImportFunction = (...args: never[]) => number;

/** args_*, environ_*, proc_exit and sched_yield. */
export function launchFunctions(memory: () => GuestMemory, launch: Launch, guarded: (body: () => void) => number): Readonly<Record<string, ImportFunction>> {
  const sizes = (list: readonly Uint8Array[], countOut: number, sizeOut: number) => guarded(() => {
    const guest = memory();
    guest.setU32(countOut, list.length); guest.setU32(sizeOut, list.reduce((total, item) => total + item.byteLength, 0));
  });
  const strings = (list: readonly Uint8Array[], pointers: number, buffer: number) => guarded(() => {
    const guest = memory();
    let at = buffer;
    list.forEach((item, index) => { guest.setU32(pointers + index * 4, at); guest.write(at, item); at += item.byteLength; });
  });
  return {
    args_sizes_get: (count: number, size: number) => sizes(launch.argv, count, size),
    args_get: (pointers: number, buffer: number) => strings(launch.argv, pointers, buffer),
    environ_sizes_get: (count: number, size: number) => sizes(launch.environ, count, size),
    environ_get: (pointers: number, buffer: number) => strings(launch.environ, pointers, buffer),
    proc_exit: (code: number) => { throw new ProcExit(code >>> 0); },
    // A single-threaded guest has nothing to yield to.
    sched_yield: () => WASI.success,
  };
}
