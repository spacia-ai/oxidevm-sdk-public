import type { LinuxSyncFiles } from "../../../js-process-types.js";
import { admitShape } from "./shape.js";
import { LIMITS } from "./limits.js";
import { admit } from "./run.js";

const O_RDONLY_CLOEXEC = 0o2000000, CHUNK = 64 * 1024, EFBIG = 27;

/** A program file larger than `LIMITS.programBytes` (EFBIG, as Linux reports a file past a limit). */
export class ProgramTooLarge extends Error {
  override readonly name = "ProgramTooLarge";
  readonly errno = EFBIG;
  constructor(path: string) { super(`${path} is larger than ${String(LIMITS.programBytes)} bytes`); }
}

/**
 * Reads a program file once, through one descriptor, in chunks, refusing it once it passes `LIMITS.programBytes`. One
 * open means one file: a rename or rewrite while it is read cannot mix two programs. Linux errors propagate.
 */
export function readProgram(host: { readonly fs: Pick<LinuxSyncFiles, "open" | "read" | "close"> }, path: string): Uint8Array {
  const fd = host.fs.open(path, O_RDONLY_CLOEXEC);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = host.fs.read(fd, CHUNK);
      if (chunk.byteLength === 0) break;
      size += chunk.byteLength;
      if (size > LIMITS.programBytes) throw new ProgramTooLarge(path);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } finally { host.fs.close(fd); }
}

/**
 * Checks a program's bytes against the profile, compiles it, then checks its imports and exports. A refused program
 * throws `AdmissionError` (or `WebAssembly.CompileError`) and none of its code runs.
 */
export async function compile(bytes: Uint8Array): Promise<WebAssembly.Module> {
  admitShape(bytes);
  const program = await WebAssembly.compile(bytes.slice());
  admit(program);
  return program;
}
