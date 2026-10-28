import type { LinuxDirectoryEntry, LinuxFileStat, LinuxPath, SeekOrigin } from "../../js-process-types.js";
import { descriptor, type LinuxOperation, type LinuxResult, noValue, operation, protocol, Reader, value, Writer } from "./codec.js";

const BigInt = globalThis.BigInt, DataView = globalThis.DataView;
export const files = {
  pollPipes: (entries: readonly { readonly fd: number; readonly events: 1 | 4 }[]) => {
    if (entries.length === 0 || entries.length > 16 || new Set(entries.map(entry => entry.fd)).size !== entries.length) protocol("Invalid ordered pipe descriptor count");
    const payload = new Writer().u32(entries.length);
    for (const entry of entries) {
      payload.u64(descriptor(entry.fd)).u32(entry.events);
    }
    return operation(65549, payload, result => {
      if (result.bytes.byteLength !== entries.length * 8) protocol("Invalid ordered pipe result length");
      const reader = new Reader(result.bytes), seen = new Set<number>();
      const ready = entries.map(() => {
        const fd = reader.u32(), masks = reader.u32(), events = masks & 0xffff, revents = masks >>> 16;
        const entry = entries.find(entry => entry.fd === fd);
        if (entry === undefined || seen.has(fd) || events !== entry.events || (revents & ~61) !== 0) protocol("Invalid ordered pipe identity or events");
        seen.add(fd);
        return { fd, events: entry.events, revents };
      });
      reader.end();
      if (result.value === 0n || result.value !== BigInt(ready.filter(entry => entry.revents !== 0).length)) protocol("Invalid ordered pipe readiness count");
      return ready;
    });
  },
  poll: (entries: readonly { readonly fd: number; readonly events: 1 | 4 }[]) => {
    if (entries.length === 0 || entries.length > 16) protocol("Invalid Linux readiness descriptor count");
    const payload = new Writer().u32(entries.length);
    for (const entry of entries) payload.u64(descriptor(entry.fd)).u32(entry.events);
    return operation(7, payload, result => {
      if (result.bytes.byteLength !== entries.length * 8) protocol("Invalid Linux readiness result");
      const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
      const events = entries.map((entry, index) => {
        const offset = index * 8;
        if (view.getInt32(offset, true) !== entry.fd || view.getUint16(offset + 4, true) !== entry.events) protocol("Linux readiness descriptor mismatch");
        return view.getUint16(offset + 6, true);
      });
      if (result.value !== BigInt(events.filter(value => value !== 0).length) || result.value === 0n) protocol("Invalid Linux readiness count");
      return events;
    });
  },
  statusFlags: (fd: number, flags?: number) => operation(72, flags === undefined ? new Writer().u64(fd).u32(3) : new Writer().u64(fd).u32(4).u64(flags), value),
  open: (path: LinuxPath, flags = 0, mode = 0o666) => operation(2, new Writer().path(path).u64(flags).u64(mode), result => descriptor(value(result))),
  read: (fd: number, count: number) => operation(0, new Writer().u64(fd).u64(count), result => { if (result.value !== BigInt(result.bytes.byteLength) || result.bytes.byteLength > count) protocol("Invalid Linux read result"); return result.bytes; }),
  write: (fd: number, bytes: Uint8Array) => operation(1, new Writer().u64(fd).blob(bytes), result => { const count = value(result); if (count > bytes.byteLength) protocol("Invalid Linux write result"); return count; }),
  seek: (fd: number, offset: bigint, origin: SeekOrigin = "start") => {
    if (offset < -0x8000_0000_0000_0000n || offset > 0x7fff_ffff_ffff_ffffn) protocol("Linux seek offset is out of range");
    return operation(8, new Writer().u64(fd).u64(BigInt.asUintN(64, offset)).u8(origin === "start" ? 0 : origin === "current" ? 1 : 2), result => { if (result.bytes.byteLength !== 0) protocol("Invalid Linux seek result"); return BigInt.asIntN(64, result.value); });
  },
  close: (fd: number) => operation(3, new Writer().u64(fd), noValue),
  dup: (fd: number, target?: number) => operation(target === undefined ? 32 : 33, target === undefined ? new Writer().u64(fd) : new Writer().u64(fd).u64(target), result => descriptor(value(result))),
  pipe: () => operation(22, new Writer(), result => { if (result.value !== 0n || result.bytes.byteLength !== 8) protocol("Invalid Linux pipe result"); const r = new Reader(result.bytes); return [descriptor(r.u32()), descriptor(r.u32())] as const; }),
  stat: (path: LinuxPath, follow = true) => operation(follow ? 4 : 6, new Writer().path(path), decodeStat),
  fstat: (fd: number) => operation(5, new Writer().u64(fd), decodeStat),
  realpath: (path: LinuxPath) => operation(65536, new Writer().path(path), result => new TextDecoder().decode(result.bytes)),
  pathInfo: (path: LinuxPath) => operation(65545, new Writer().path(path), result => {
    if (result.value !== 0n) protocol("Invalid canonical metadata result");
    const reader = new Reader(result.bytes);
    const stat = decodeStat({ value: 0n, bytes: reader.raw(144) });
    const canonical = reader.text(4095); reader.end();
    if (!canonical.startsWith("/") || canonical.includes("\0")) protocol("Invalid canonical metadata path");
    return { path: canonical, stat };
  }),
  mkdir: (path: LinuxPath, mode = 0o777) => operation(83, new Writer().path(path).u64(mode), noValue),
  rename: (from: LinuxPath, to: LinuxPath) => operation(82, new Writer().path(from).path(to), noValue),
  unlink: (path: LinuxPath, directory = false) => operation(directory ? 84 : 87, new Writer().path(path), noValue),
  fsync: (fd: number) => operation(74, new Writer().u64(fd), noValue),
  getdents: (fd: number): LinuxOperation<readonly LinuxDirectoryEntry[]> => operation(217, new Writer().u64(fd).u64(64 * 1024), decodeEntries),
};
function decodeStat(result: LinuxResult): LinuxFileStat & { readonly rdev: bigint; readonly blockSize: bigint; readonly blocks: bigint } {
  if (result.value !== 0n || result.bytes.byteLength !== 144) protocol("Invalid Linux stat result");
  const v = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  const time = (offset: number) => { const ns = v.getBigUint64(offset + 8, true); if (ns >= 1_000_000_000n) protocol("Invalid Linux timestamp"); return v.getBigInt64(offset, true) * 1_000_000_000n + ns; };
  return { device: v.getBigUint64(0, true), inode: v.getBigUint64(8, true), links: v.getBigUint64(16, true), mode: v.getUint32(24, true), uid: v.getUint32(28, true), gid: v.getUint32(32, true), size: v.getBigInt64(48, true), rdev: v.getBigUint64(40, true), blockSize: v.getBigInt64(56, true), blocks: v.getBigInt64(64, true), accessedNs: time(72), modifiedNs: time(88), changedNs: time(104) };
}
function decodeEntries(result: LinuxResult): readonly LinuxDirectoryEntry[] {
  if (result.value !== BigInt(result.bytes.byteLength)) protocol("Invalid Linux directory result");
  const entries: LinuxDirectoryEntry[] = [], view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  let offset = 0;
  while (offset < result.bytes.byteLength) {
    if (offset + 20 > result.bytes.byteLength) protocol("Truncated Linux directory entry");
    const length = view.getUint16(offset + 16, true);
    if (length < 20 || length % 8 !== 0 || length > result.bytes.byteLength - offset) protocol("Invalid Linux directory entry length");
    const end = result.bytes.indexOf(0, offset + 19);
    if (end < 0 || end >= offset + length) protocol("Invalid Linux directory entry name");
    const nameBytes = result.bytes.slice(offset + 19, end);
    entries.push({ nameBytes, name: new TextDecoder().decode(nameBytes), type: view.getUint8(offset + 18) });
    offset += length;
  }
  return entries;
}
