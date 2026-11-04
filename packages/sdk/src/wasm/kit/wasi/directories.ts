import { WASI } from "./errno.js";
import type { LinuxDirent } from "./host.js";
import type { GuestMemory } from "./memory.js";
import { WasiError, type WasiContext } from "./context.js";
import { RIGHT } from "./rights.js";

type ImportFunction = (...args: never[]) => number;
const HEADER = 24;
const BATCH = 64 * 1024;

/** Linux d_type → WASI filetype (DT_FIFO and DT_UNKNOWN have no WASI name). */
export function direntType(type: number): number {
  switch (type) {
    case 2: return 2; case 4: return 3; case 6: return 1; case 8: return 4; case 10: return 7; case 12: return 6;
    default: return 0;
  }
}

/** One WASI dirent: d_next u64, d_ino u64, d_namlen u32, d_type u8, padding, then the raw name. */
export function encodeDirent(entry: LinuxDirent): Uint8Array {
  const bytes = new Uint8Array(HEADER + entry.name.byteLength), view = new DataView(bytes.buffer);
  view.setBigUint64(0, entry.next, true); view.setBigUint64(8, entry.inode, true);
  view.setUint32(16, entry.name.byteLength, true); view.setUint8(20, direntType(entry.type));
  bytes.set(entry.name, HEADER);
  return bytes;
}

/**
 * Fills `capacity` bytes with records starting after `cookie` (0 = the first entry). The held directory descriptor is
 * positioned at the cookie each call, so a directory renamed meanwhile is still the one read. A record that does not
 * fit is cut at the buffer end, as WASI requires: `used == capacity` tells the caller to retry from the last whole
 * record with a larger buffer.
 */
export function readDirectory(context: WasiContext, memory: GuestMemory, fd: number, buffer: number, capacity: number, cookie: bigint): number {
  const entry = context.table.require(fd, RIGHT.fdReaddir);
  if (entry.kind !== "directory" && entry.kind !== "preopen") throw new WasiError(WASI.notdir);
  memory.check(buffer, capacity);
  if (cookie > 0x7fff_ffff_ffff_ffffn) throw new WasiError(WASI.inval);
  context.host.fs.seek(entry.host, cookie, "start");
  let used = 0;
  for (;;) {
    const batch = context.at.getdents(entry.host, BATCH);
    if (batch.length === 0) return used;
    for (const record of batch) {
      const bytes = encodeDirent(record), room = capacity - used;
      memory.write(buffer + used, bytes.subarray(0, room));
      used += Math.min(room, bytes.byteLength);
      if (used === capacity) return used;
    }
  }
}

export function directoryFunctions(context: WasiContext): Readonly<Record<string, ImportFunction>> {
  return {
    fd_readdir: (fd: number, buffer: number, capacity: number, cookie: bigint, out: number) => context.guarded(() => {
      const memory = context.memory();
      memory.check(out, 4);
      memory.setU32(out, readDirectory(context, memory, fd, buffer, capacity, cookie));
    }),
  };
}
