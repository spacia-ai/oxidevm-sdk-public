import { LIMITS } from "./limits.js";
import { AdmissionError } from "./admission.js";

/**
 * The structural profile of a guest-supplied program, checked on its bytes before compilation: a WebAssembly 1.0 core
 * module (not a component), one defined, unshared, 32-bit memory with a declared maximum of at most LIMITS.memoryPages,
 * no imported memory or table, at most one funcref table with a declared maximum of at most LIMITS.tableEntries, and no
 * start section (which would run before the adapter binds memory). Import names and exports are checked after
 * compilation by `admitProgram`.
 */
export function admitShape(bytes: Uint8Array): void {
  const fail = (reason: string): never => { throw new AdmissionError(reason); };
  if (bytes.byteLength > LIMITS.programBytes) fail(`is larger than ${String(LIMITS.programBytes)} bytes`);
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail("is not a WebAssembly binary");
  if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) fail("is not a WebAssembly 1.0 core module (a component or another version)");
  let at = 8;
  const leb = (): number => {
    let value = 0, shift = 0;
    for (;;) {
      const byte = bytes[at];
      if (byte === undefined || shift > 28) return fail("has a truncated section");
      value += (byte & 0x7f) * 2 ** shift; at += 1; shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const limits = (): { readonly max: number | null; readonly shared: boolean; readonly memory64: boolean } => {
    const flags = bytes[at] ?? fail("has truncated limits");
    at += 1;
    if ((flags & ~0x7) !== 0) fail("uses unknown limits flags");
    leb();
    return { max: (flags & 1) !== 0 ? leb() : null, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 };
  };
  const skipName = () => { const length = leb(); at += length; if (at > bytes.byteLength) fail("has a truncated name"); };
  let memories = 0, tables = 0;
  while (at < bytes.byteLength) {
    const id = bytes[at] ?? fail("is truncated");
    at += 1;
    const size = leb(), end = at + size;
    if (end > bytes.byteLength) fail("has a section past its end");
    if (id === 2) {
      for (let count = leb(); count > 0; count -= 1) {
        skipName(); skipName();
        const kind = bytes[at] ?? fail("has a truncated import");
        at += 1;
        if (kind !== 0) fail(kind === 2 ? "imports its memory" : kind === 1 ? "imports a table" : "imports a global or tag");
        leb();
      }
    } else if (id === 4) {
      for (let count = leb(); count > 0; count -= 1) {
        tables += 1;
        if (bytes[at] !== 0x70) fail("defines a table that is not funcref");
        at += 1;
        const table = limits();
        if (table.max === null || table.max > LIMITS.tableEntries) fail(`defines a table without a maximum of at most ${String(LIMITS.tableEntries)}`);
      }
    } else if (id === 5) {
      for (let count = leb(); count > 0; count -= 1) {
        memories += 1;
        const memory = limits();
        if (memory.shared) fail("defines a shared memory");
        if (memory.memory64) fail("defines a 64-bit memory");
        if (memory.max === null || memory.max > LIMITS.memoryPages) fail(`defines a memory without a maximum of at most ${String(LIMITS.memoryPages)} pages (256 MiB)`);
      }
    } else if (id === 8) fail("has a start section");
    at = end;
  }
  if (tables > 1) fail("defines more than one table");
  if (memories !== 1) fail(memories === 0 ? "defines no memory" : "defines more than one memory");
}
