import { describe, expect, it } from "vitest";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { FAKE_CLOCK, fakeLinux } from "./memory-linux.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0o100, O_EXCL = 0o200, O_DIRECTORY = 0o200000, O_NONBLOCK = 0o4000;
const RESOLVE_BENEATH = 8;
function errno(action: () => unknown): number | undefined {
  try { action(); } catch (error: unknown) { if (error instanceof LinuxError) return error.errno; throw error; }
  return undefined;
}

describe("fakeLinux standard streams", () => {
  it("writes to standard output and error through both facades and reports them as pipes", async () => {
    const linux = fakeLinux({ args: [] });
    expect(linux.filesSync.write(linux.stdout, encoder.encode("one\n"))).toBe(4);
    expect(await linux.files.write(linux.stderr, encoder.encode("two\n"))).toBe(4);
    expect(linux.stdoutLines).toEqual(["one"]);
    expect(linux.stderrLines).toEqual(["two"]);
    for (const fd of [linux.stdin, linux.stdout, linux.stderr]) expect(linux.filesSync.fstat(fd).mode).toBe(0o010600);
    expect(errno(() => linux.filesSync.write(linux.stdin, encoder.encode("x")))).toBe(9);
  });

  it("reads standard input synchronously, EAGAIN when non-blocking and empty, and refuses a read that would hang", () => {
    const given = fakeLinux({ args: [], stdin: encoder.encode("in") });
    expect(decoder.decode(given.filesSync.read(given.stdin, 16))).toBe("in");
    expect(given.filesSync.read(given.stdin, 16)).toHaveLength(0);
    const open = fakeLinux({ args: [] });
    expect(() => open.filesSync.read(open.stdin, 1)).toThrow(/would wait forever/u);
    open.filesAt.setStatusFlags(open.stdin, O_NONBLOCK);
    expect(open.filesAt.statusFlags(open.stdin)).toBe(O_NONBLOCK);
    expect(errno(() => open.filesSync.read(open.stdin, 1))).toBe(11);
  });
});

describe("fakeLinux host.at over the in-memory files", () => {
  const tree = () => fakeLinux({ args: [], cwd: "/workspace", existingFiles: { "/workspace/a.txt": { bytes: encoder.encode("hello"), mode: 0o644 } } });

  it("opens relative to a held directory, reads and writes positionally, and keeps the files the fake reports", () => {
    const linux = tree(), { filesAt: at } = linux;
    const dir = at.openat(at.cwd, ".", O_RDONLY | O_DIRECTORY, 0);
    const file = at.openat(dir, "a.txt", O_RDWR, 0);
    expect(decoder.decode(at.pread(file, 3, 1n))).toBe("ell");
    expect(at.pwrite(file, encoder.encode("J"), 0n)).toBe(1);
    expect(decoder.decode(linux.filesSync.read(file, 16))).toBe("Jello");
    const created = at.openat(dir, "new.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600);
    linux.filesSync.writeAll(created, encoder.encode("made"));
    expect(decoder.decode(linux.written.get("/workspace/new.txt")?.bytes)).toBe("made");
    expect(at.statAt(dir, "new.txt")).toMatchObject({ mode: 0o100600, size: 4n });
    expect(errno(() => at.openat(dir, "new.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600))).toBe(17);
    expect(errno(() => at.openat(dir, "missing", O_RDONLY, 0))).toBe(2);
  });

  it("confines RESOLVE_BENEATH to the held directory against .., absolute paths and links, even after a swap", () => {
    const linux = tree(), { filesAt: at } = linux;
    at.mkdirAt(at.cwd, "jail", 0o755);
    at.mkdirAt(at.cwd, "jail/sub", 0o755);
    const jail = at.openat(at.cwd, "jail", O_RDONLY | O_DIRECTORY, 0);
    expect(errno(() => at.openat(jail, "../a.txt", O_RDONLY, 0, RESOLVE_BENEATH))).toBe(18);
    expect(errno(() => at.openat(jail, "/workspace/a.txt", O_RDONLY, 0, RESOLVE_BENEATH))).toBe(18);
    at.symlinkAt("/workspace", jail, "out");
    expect(errno(() => at.openat(jail, "out/a.txt", O_RDONLY, 0, RESOLVE_BENEATH))).toBe(18);
    // Without the flag the same paths resolve, and `..` that stays beneath is fine.
    expect(at.openat(jail, "../a.txt", O_RDONLY, 0)).toBeGreaterThan(2);
    expect(at.openat(jail, "sub/..", O_RDONLY | O_DIRECTORY, 0, RESOLVE_BENEATH)).toBeGreaterThan(2);
    // A component swapped for a link between two requests is confined as well.
    at.unlinkAt(jail, "sub", 0x200);
    at.symlinkAt("../..", jail, "sub");
    expect(errno(() => at.openat(jail, "sub/a.txt", O_RDONLY, 0, RESOLVE_BENEATH))).toBe(18);
    expect(Array.from(at.readlinkAt(jail, "sub"))).toEqual(Array.from(encoder.encode("../..")));
  });

  it("lists a directory in batches whose d_off cookies resume after a seek", () => {
    const linux = tree(), { filesAt: at } = linux;
    for (const name of ["b", "c", "d"]) at.mkdirAt(at.cwd, name, 0o755);
    const dir = at.openat(at.cwd, ".", O_RDONLY | O_DIRECTORY, 0);
    const first = at.getdents(dir, 48);
    expect(first.map(entry => decoder.decode(entry.name))).toEqual([".", ".."]);
    const all = [...first];
    for (let batch = at.getdents(dir, 4096); batch.length > 0; batch = at.getdents(dir, 4096)) all.push(...batch);
    expect(all.map(entry => decoder.decode(entry.name))).toEqual([".", "..", "a.txt", "b", "c", "d"]);
    expect(all.find(entry => decoder.decode(entry.name) === "a.txt")).toMatchObject({ type: 8, inode: at.statAt(at.cwd, "a.txt").inode });
    const cookie = all[2]?.next ?? 0n;
    linux.filesSync.seek(dir, cookie);
    expect(at.getdents(dir, 4096).map(entry => decoder.decode(entry.name))).toEqual(["b", "c", "d"]);
    linux.filesSync.seek(dir, 0n);
    expect(errno(() => at.getdents(dir, 8))).toBe(22);
  });

  it("renames, links, unlinks and sets times as the *at calls ask", () => {
    const linux = tree(), { filesAt: at } = linux;
    at.linkAt(at.cwd, "a.txt", at.cwd, "hard.txt");
    expect(at.statAt(at.cwd, "hard.txt").inode).toBe(at.statAt(at.cwd, "a.txt").inode);
    at.openat(at.cwd, "other.txt", O_WRONLY | O_CREAT, 0o644);
    expect(errno(() => at.renameAt(at.cwd, "a.txt", at.cwd, "other.txt", 1))).toBe(17);
    at.renameAt(at.cwd, "a.txt", at.cwd, "other.txt", 2);
    expect(at.statAt(at.cwd, "other.txt").size).toBe(5n);
    expect(at.statAt(at.cwd, "a.txt").size).toBe(0n);
    at.utimensAt(at.cwd, "other.txt", 1_000_000_001n, "omit");
    expect(at.statAt(at.cwd, "other.txt").accessedNs).toBe(1_000_000_001n);
    at.unlinkAt(at.cwd, "hard.txt");
    expect(errno(() => at.statAt(at.cwd, "hard.txt"))).toBe(2);
    expect(errno(() => at.unlinkAt(at.cwd, "missing"))).toBe(2);
    expect(linux.unlinked).toContain("/workspace/hard.txt");
  });

  it("answers readiness of files at once, times out empty input on the fake clock, and refuses a poll that would hang", () => {
    const linux = fakeLinux({ args: [], cwd: "/workspace" }), { filesAt: at } = linux;
    const file = at.openat(at.cwd, "f", O_RDWR | O_CREAT, 0o644);
    expect(at.poll([{ fd: file, events: 5 }, { fd: linux.stdout, events: 4 }], -1)).toEqual([{ fd: file, revents: 5 }, { fd: linux.stdout, revents: 4 }]);
    const before = linux.clock.now("monotonic");
    expect(at.poll([{ fd: linux.stdin, events: 1 }], 250)).toEqual([]);
    expect(linux.clock.now("monotonic") - before).toBe(250_000_000n + FAKE_CLOCK.stepNs);
    expect(() => at.poll([{ fd: linux.stdin, events: 1 }], -1)).toThrow(/wait forever/u);
  });
});

describe("fakeLinux clock and random", () => {
  it("reads deterministic clocks that move forward by one step per reading", () => {
    const linux = fakeLinux({ args: [] });
    expect(linux.clock.now("monotonic")).toBe(FAKE_CLOCK.monotonicStartNs);
    expect(linux.clock.now("monotonic")).toBe(FAKE_CLOCK.monotonicStartNs + FAKE_CLOCK.stepNs);
    expect(linux.clock.now("realtime")).toBe(FAKE_CLOCK.realtimeStartNs + 2n * FAKE_CLOCK.stepNs);
    linux.advanceClock(5n);
    expect(linux.clock.now("monotonic")).toBe(FAKE_CLOCK.monotonicStartNs + 3n * FAKE_CLOCK.stepNs + 5n);
    expect(linux.clock.resolution("realtime")).toBe(1n);
  });

  it("fills the same bytes for the same seed: test bytes, not entropy", () => {
    const fill = (seed?: number): number[] => { const bytes = new Uint8Array(32); fakeLinux({ args: [], ...(seed === undefined ? {} : { randomSeed: seed }) }).random.fill(bytes); return Array.from(bytes); };
    expect(fill()).toEqual(fill());
    expect(fill(7)).toEqual(fill(7));
    expect(fill(7)).not.toEqual(fill(8));
    expect(new Set(fill()).size).toBeGreaterThan(8);
  });

  it("answers infoSync and leaves the other synchronous process calls unmodelled (ENOSYS)", () => {
    const linux = fakeLinux({ args: ["a"], cwd: "/w" });
    expect(linux.processSync.infoSync()).toMatchObject({ pid: 42, cwd: "/w", args: ["a"] });
    expect(errno(() => linux.processSync.runSync({ command: "/bin/true", timeoutMs: 1, stdoutLimit: 0, stderrLimit: 0 }))).toBe(38);
  });
});
