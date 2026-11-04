import { describe, expect, it } from "vitest";
import { VMError } from "../errors.js";
import { atFileOperations as at, atFiles, CWD } from "./at-operations.js";
import { descriptor, type LinuxOperation, type LinuxResult } from "./codec.js";

const u32 = (value: number): number[] => Array.from(new Uint8Array(new Uint32Array([value]).buffer));
const u64 = (value: bigint): number[] => Array.from(new Uint8Array(new BigUint64Array([BigInt.asUintN(64, value)]).buffer));
const blob = (text: string): number[] => [...u32(text.length), ...new TextEncoder().encode(text)];
const wire = (operation: { readonly number: number; readonly payload: Uint8Array }) => ({ number: operation.number, payload: Array.from(operation.payload) });
const empty = (value = 0n): LinuxResult => ({ value, bytes: new Uint8Array() });
const fd = descriptor(3);
const AT_FDCWD = u64(0xffff_ffff_ffff_ff9cn);
function thrown(action: () => unknown): unknown { try { action(); } catch (error: unknown) { return error; } return undefined; }

describe("descriptor-relative operations (Userspace API 147)", () => {
  it("sends AT_FDCWD as -100 in an unsigned word and a held directory as its number", () => {
    expect(CWD).toBe(-100);
    expect(wire(at.openat(CWD, "a", 0o102, 0o644, 8))).toEqual({ number: 437, payload: [...AT_FDCWD, ...blob("a"), ...u64(0o102n), ...u64(0o644n), ...u64(8n)] });
    expect(wire(at.openat(fd, "b", 0, 0))).toEqual({ number: 437, payload: [...u64(3n), ...blob("b"), ...u64(0n), ...u64(0n), ...u64(0n)] });
    expect(at.openat(fd, "b", 0, 0).decode(empty(7n))).toBe(7);
    for (const bad of [empty(-1n), empty(2n ** 31n), { value: 7n, bytes: new Uint8Array(1) }]) expect(() => at.openat(fd, "b", 0, 0).decode(bad)).toThrow(VMError);
  });

  it("pins the record of every *at operation: directories, paths and flags in the order Rust reads them", () => {
    expect(wire(at.statAt(fd, "s", 0x100))).toEqual({ number: 262, payload: [...u64(3n), ...blob("s"), ...u64(0x100n)] });
    expect(wire(at.mkdirAt(CWD, "d", 0o755))).toEqual({ number: 258, payload: [...AT_FDCWD, ...blob("d"), ...u64(0o755n)] });
    expect(wire(at.unlinkAt(fd, "d", 0x200))).toEqual({ number: 263, payload: [...u64(3n), ...blob("d"), ...u64(0x200n)] });
    expect(wire(at.renameAt(fd, "a", CWD, "b", 1))).toEqual({ number: 316, payload: [...u64(3n), ...blob("a"), ...AT_FDCWD, ...blob("b"), ...u64(1n)] });
    expect(wire(at.linkAt(CWD, "a", fd, "b", 0x400))).toEqual({ number: 265, payload: [...AT_FDCWD, ...blob("a"), ...u64(3n), ...blob("b"), ...u64(0x400n)] });
    expect(wire(at.symlinkAt("../t", fd, "l"))).toEqual({ number: 266, payload: [...blob("../t"), ...u64(3n), ...blob("l")] });
    expect(wire(at.readlinkAt(fd, "l"))).toEqual({ number: 267, payload: [...u64(3n), ...blob("l")] });
    // An empty path is Rust's to judge (AT_EMPTY_PATH); raw bytes travel unchanged.
    expect(wire(at.statAt(fd, "", 0x1000)).payload).toEqual([...u64(3n), ...u32(0), ...u64(0x1000n)]);
    expect(wire(at.statAt(fd, Uint8Array.of(0xff, 0xfe))).payload).toEqual([...u64(3n), ...u32(2), 0xff, 0xfe, ...u64(0n)]);
  });

  it("decodes stat exactly and void replies strictly", () => {
    const stat = new Uint8Array(144), view = new DataView(stat.buffer);
    view.setBigUint64(8, 2n ** 64n - 1n, true); view.setUint32(24, 0o040755, true);
    expect(at.statAt(fd, "s").decode({ value: 0n, bytes: stat })).toMatchObject({ inode: 2n ** 64n - 1n, mode: 0o040755 });
    for (const bytes of [stat.subarray(0, 143), new Uint8Array(145)]) expect(() => at.statAt(fd, "s").decode({ value: 0n, bytes })).toThrow(VMError);
    for (const operation of [at.mkdirAt(fd, "d", 0), at.unlinkAt(fd, "d"), at.renameAt(fd, "a", fd, "b"), at.linkAt(fd, "a", fd, "b"), at.symlinkAt("t", fd, "l"), at.utimensAt(fd, "a", "now", "omit"), at.fdatasync(fd), at.setStatusFlags(fd, 0o4000)]) {
      expect(() => operation.decode(empty())).not.toThrow();
      expect(() => operation.decode(empty(1n))).toThrow(VMError);
      expect(() => operation.decode({ value: 0n, bytes: new Uint8Array(1) })).toThrow(VMError);
    }
  });

  it("returns a link's raw target bytes and refuses an empty, mislabelled or oversized one", () => {
    const target = Uint8Array.of(0x2e, 0xff, 0x00, 0x41);
    const decoded = at.readlinkAt(fd, "l").decode({ value: 4n, bytes: target });
    expect(Array.from(decoded)).toEqual([0x2e, 0xff, 0x00, 0x41]);
    for (const bad of [{ value: 3n, bytes: target }, empty(), { value: 4096n, bytes: new Uint8Array(4096) }]) expect(() => at.readlinkAt(fd, "l").decode(bad)).toThrow(VMError);
  });

  it("encodes utimensat_at times as floored seconds and nanoseconds, or the UTIME words", () => {
    expect(wire(at.utimensAt(fd, "a", 1_500_000_000n, -1n, 0x100))).toEqual({
      number: 65551, payload: [...u64(3n), ...blob("a"), ...u64(1n), ...u64(500_000_000n), ...u64(-1n), ...u64(999_999_999n), ...u64(0x100n)],
    });
    expect(wire(at.utimensAt(CWD, "", "now", "omit", 0x1000)).payload).toEqual([...AT_FDCWD, ...u32(0), ...u64(0n), ...u64(0x3fff_ffffn), ...u64(0n), ...u64(0x3fff_fffen), ...u64(0x1000n)]);
    expect(thrown(() => at.utimensAt(fd, "a", 2n ** 63n * 1_000_000_000n, "now"))).toMatchObject({ code: "INVALID_ARGUMENT" });
    const unlisted: unknown = 5;
    expect(thrown(() => Reflect.apply(at.utimensAt, undefined, [fd, "a", unlisted, "now"]))).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("refuses descriptors, flags, offsets and paths Linux would not take before anything is sent", () => {
    for (const build of [() => at.openat(descriptor(3), "a\0", 0, 0), () => at.statAt(fd, "x".repeat(4096)), () => at.openat(fd, "a", -1, 0), () => at.openat(fd, "a", 0, 0, 1.5), () => at.pread(fd, 1, -1n), () => at.pread(fd, 1, 2n ** 63n), () => at.pwrite(fd, new Uint8Array(1), -1n), () => at.pread(fd, 16 * 1024 ** 2 + 1, 0n), () => at.getdents(fd, 0)]) {
      expect(thrown(build)).toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    const negative: unknown = -5;
    expect(thrown(() => Reflect.apply(at.mkdirAt, undefined, [negative, "d", 0]))).toMatchObject({ code: "INVALID_ARGUMENT" });
    // AT_FDCWD names a directory; it is not a descriptor for positional I/O.
    expect(thrown(() => at.pread(CWD, 1, 0n))).toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("positional, status and directory operations", () => {
  it("encodes pread and pwrite with their offsets and bounds their replies", () => {
    expect(wire(at.pread(fd, 4, 9n))).toEqual({ number: 17, payload: [...u64(3n), ...u64(4n), ...u64(9n)] });
    expect(Array.from(at.pread(fd, 4, 9n).decode({ value: 2n, bytes: Uint8Array.of(1, 2) }))).toEqual([1, 2]);
    for (const bad of [{ value: 3n, bytes: Uint8Array.of(1, 2) }, { value: 5n, bytes: new Uint8Array(5) }]) expect(() => at.pread(fd, 4, 9n).decode(bad)).toThrow(VMError);
    expect(wire(at.pwrite(fd, Uint8Array.of(7, 8), 2n ** 63n - 1n))).toEqual({ number: 18, payload: [...u64(3n), ...u32(2), 7, 8, ...u64(2n ** 63n - 1n)] });
    expect(at.pwrite(fd, Uint8Array.of(7, 8), 0n).decode(empty(2n))).toBe(2);
    expect(() => at.pwrite(fd, Uint8Array.of(7, 8), 0n).decode(empty(3n))).toThrow(VMError);
  });

  it("reads and sets status flags with F_GETFL and F_SETFL, and syncs data with fdatasync", () => {
    expect(wire(at.statusFlags(fd))).toEqual({ number: 72, payload: [...u64(3n), ...u32(3)] });
    expect(at.statusFlags(fd).decode(empty(0o4002n))).toBe(0o4002);
    expect(wire(at.setStatusFlags(fd, 0o4000))).toEqual({ number: 72, payload: [...u64(3n), ...u32(4), ...u64(0o4000n)] });
    expect(wire(at.fdatasync(fd))).toEqual({ number: 75, payload: u64(3n) });
  });

  it("decodes getdents64 records with their inode, d_type, raw name and the d_off cookie", () => {
    const record = (inode: bigint, next: bigint, type: number, name: number[]): number[] => {
      const length = Math.ceil((19 + name.length + 1) / 8) * 8, bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
      view.setBigUint64(0, inode, true); view.setBigUint64(8, next, true); view.setUint16(16, length, true); view.setUint8(18, type); bytes.set(name, 19);
      return Array.from(bytes);
    };
    const bytes = Uint8Array.from([...record(2n ** 64n - 1n, 1n, 4, [0x2e]), ...record(9n, 2n ** 63n + 5n, 8, [0x61, 0xff])]);
    const batch = at.getdents(fd, 4096);
    expect(wire(batch)).toEqual({ number: 217, payload: [...u64(3n), ...u64(4096n)] });
    const entries = batch.decode({ value: BigInt(bytes.length), bytes });
    expect(entries.map(entry => ({ ...entry, name: Array.from(entry.name) }))).toEqual([
      { name: [0x2e], inode: 2n ** 64n - 1n, type: 4, next: 1n },
      { name: [0x61, 0xff], inode: 9n, type: 8, next: 2n ** 63n + 5n },
    ]);
    expect(batch.decode(empty())).toEqual([]);
    // Truncated, trailing, mislabelled, nameless and larger-than-asked batches are protocol errors.
    const nameless = Uint8Array.from(record(1n, 1n, 8, [])), unterminated = Uint8Array.from(record(1n, 1n, 8, [0x61])).fill(0x61, 19);
    for (const bad of [bytes.subarray(0, bytes.length - 8), Uint8Array.from([...bytes, 0, 0, 0, 0]), nameless, unterminated]) expect(() => batch.decode({ value: BigInt(bad.length), bytes: bad })).toThrow(VMError);
    expect(() => batch.decode({ value: 1n, bytes })).toThrow(VMError);
    expect(() => at.getdents(fd, 24).decode({ value: BigInt(bytes.length), bytes })).toThrow(VMError);
  });
});

describe("timed readiness (OXJR 65552)", () => {
  const reply = (entries: readonly (readonly [number, number, number])[]): Uint8Array => {
    const bytes = new Uint8Array(entries.length * 8), view = new DataView(bytes.buffer);
    entries.forEach(([fd, events, revents], index) => { view.setInt32(index * 8, fd, true); view.setUint16(index * 8 + 4, events, true); view.setUint16(index * 8 + 6, revents, true); });
    return bytes;
  };
  const four = descriptor(4);

  it("encodes the descriptors, their events and the signed timeout", () => {
    expect(wire(at.poll([{ fd, events: 1 }, { fd: four, events: 5 }], 250))).toEqual({ number: 65552, payload: [...u32(2), ...u64(3n), ...u32(1), ...u64(4n), ...u32(5), ...u64(250n)] });
    expect(wire(at.poll([{ fd, events: 4 }], -1)).payload.slice(-8)).toEqual(u64(-1n));
  });

  it("answers only the ready descriptors, and nothing on a timeout", () => {
    const poll = at.poll([{ fd, events: 1 }, { fd: four, events: 4 }], 10);
    expect(poll.decode({ value: 1n, bytes: reply([[3, 1, 0], [4, 4, 4 | 16]]) })).toEqual([{ fd: 4, revents: 20 }]);
    expect(poll.decode({ value: 0n, bytes: reply([[3, 1, 0], [4, 4, 0]]) })).toEqual([]);
    for (const bad of [{ value: 1n, bytes: reply([[3, 1, 0], [4, 4, 0]]) }, { value: 0n, bytes: reply([[3, 1, 1], [4, 4, 0]]) }, { value: 1n, bytes: reply([[4, 4, 4], [3, 1, 0]]) }, { value: 1n, bytes: reply([[3, 4, 4], [4, 4, 0]]) }, { value: 0n, bytes: reply([[3, 1, 0]]) }, { value: 0n, bytes: Uint8Array.from([...reply([[3, 1, 0], [4, 4, 0]]), 0]) }]) {
      expect(() => poll.decode(bad)).toThrow(VMError);
    }
  });

  it("refuses an empty or oversized set, other events and timeouts out of range before anything is sent", () => {
    const sixteen = Array.from({ length: 16 }, () => ({ fd, events: 1 as const }));
    expect(() => at.poll(sixteen, 0)).not.toThrow();
    const unlisted: unknown = 2;
    for (const build of [() => at.poll([], 0), () => at.poll([...sixteen, { fd, events: 1 }], 0), () => at.poll([{ fd, events: 1 }], -2), () => at.poll([{ fd, events: 1 }], 86_400_001), () => at.poll([{ fd, events: 1 }], 1.5), () => { Reflect.apply(at.poll, undefined, [[{ fd, events: unlisted }], 0]); }]) {
      expect(thrown(build)).toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
});

it("sends every host.at call synchronously on the process's own channel", () => {
  const sent: number[] = [];
  const client = { sync<T>(operation: LinuxOperation<T>): T { sent.push(operation.number); return operation.decode(operation.number === 437 ? empty(5n) : empty()); } };
  const files = atFiles(client);
  expect(Object.isFrozen(files)).toBe(true);
  expect(files.cwd).toBe(CWD);
  expect(files.openat(files.cwd, "a", 0, 0)).toBe(5);
  files.mkdirAt(fd, "d", 0o700);
  files.unlinkAt(fd, "d", 0x200);
  files.fdatasync(fd);
  expect(sent).toEqual([437, 258, 263, 75]);
});

describe("the relay's operation ceiling", () => {
  it("admits the highest operations these codecs send (65551 utimensat_at, 65552 poll_timed) and nothing above", async () => {
    const { JS_MAX_OPERATION } = await import("./codec.js");
    const numbers = [at.utimensAt(fd, "", "now", "omit").number, at.poll([{ fd, events: 1 }], 0).number];
    expect(numbers).toEqual([65551, 65552]);
    expect(Math.max(...numbers)).toBe(JS_MAX_OPERATION);
  });
});
