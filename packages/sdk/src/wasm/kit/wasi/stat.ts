import type { LinuxFileStat } from "../../../js-process-types.js";
import type { GuestMemory } from "./memory.js";

/** WASI Preview1 `filetype`. FIFOs have no WASI name and report `unknown`, as wasi-libc expects. */
export const FILETYPE = { unknown: 0, blockDevice: 1, characterDevice: 2, directory: 3, regularFile: 4, socketStream: 6, symbolicLink: 7 } as const;

export function filetypeOf(mode: number): number {
  switch (mode & 0o170000) {
    case 0o060000: return FILETYPE.blockDevice;
    case 0o020000: return FILETYPE.characterDevice;
    case 0o040000: return FILETYPE.directory;
    case 0o100000: return FILETYPE.regularFile;
    case 0o140000: return FILETYPE.socketStream;
    case 0o120000: return FILETYPE.symbolicLink;
    default: return FILETYPE.unknown;
  }
}

/** Every Preview1 right (bits 0-28). */
export const ALL_RIGHTS = (1n << 29n) - 1n;
const RIGHT_FD_SEEK = 1n << 2n, RIGHT_FD_TELL = 1n << 5n;
/**
 * Rights of a standard stream. Rust's `IsTerminal` on wasm32-wasip1 is "a character device without seek or tell rights",
 * so terminal-ness must come from Linux (`isatty`, which the runner reports), not from the file type: /dev/null is a
 * character device but not a terminal, and it can seek. Pipes and sockets cannot seek.
 */
export function streamRights(filetype: number, terminal: boolean): bigint {
  const unseekable = terminal || filetype === FILETYPE.unknown || filetype === FILETYPE.socketStream;
  return unseekable ? ALL_RIGHTS & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL) : ALL_RIGHTS;
}

/** Writes a Preview1 `filestat` (64 bytes) at `pointer`: dev, ino, filetype, nlink, size, atim, mtim, ctim. */
export function writeFilestat(memory: GuestMemory, pointer: number, stat: LinuxFileStat): void {
  memory.check(pointer, 64);
  memory.write(pointer, new Uint8Array(64));
  memory.setU64(pointer, stat.device);
  memory.setU64(pointer + 8, stat.inode);
  memory.write(pointer + 16, Uint8Array.of(filetypeOf(stat.mode)));
  memory.setU64(pointer + 24, stat.links);
  memory.setU64(pointer + 32, stat.size);
  memory.setU64(pointer + 40, stat.accessedNs);
  memory.setU64(pointer + 48, stat.modifiedNs);
  memory.setU64(pointer + 56, stat.changedNs);
}
