// Userspace API 147 against the real engine: the descriptor-relative, positional, readiness, clock and entropy
// operations a WASI adapter uses (capabilities files.at, clock, random), through the production codecs.
import { expect, it } from "vitest";

import { atFileOperations as at, CWD } from "../../js-process/at-operations.js";
import { clockOperations, randomOperation } from "../../js-process/clock-random.js";
import { files } from "../../js-process/file-operations.js";
import { fixture, operations } from "./bridge-fixture.test-support.js";

const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0o100, O_DIRECTORY = 0o200000, O_PATH = 0o10000000, O_CLOEXEC = 0o2000000;
const RESOLVE_BENEATH = 8, RESOLVE_NO_MAGICLINKS = 2, AT_EMPTY_PATH = 0x1000, AT_REMOVEDIR = 0x200;
const EXDEV = 18;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

it("confines openat2 beneath a held directory: .., an absolute symlink and a swapped component cannot escape", async () => {
  const f = await fixture();
  try {
    const { send, failure } = operations(f);
    send(at.mkdirAt(CWD, "/workspace/jail", 0o755));
    send(at.mkdirAt(CWD, "/workspace/jail/sub", 0o755));
    const jail = send(at.openat(CWD, "/workspace/jail", O_PATH | O_DIRECTORY | O_CLOEXEC, 0));
    const created = send(at.openat(jail, "sub/f", O_CREAT | O_WRONLY | O_CLOEXEC, 0o644, RESOLVE_BENEATH));
    expect(send(files.write(created, new TextEncoder().encode("in")))).toBe(2);
    send(files.close(created));
    expect(failure(at.openat(jail, "../outside", O_CREAT | O_WRONLY, 0o644, RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS))).toBe(EXDEV);
    send(at.symlinkAt("/workspace", jail, "abs"));
    expect(failure(at.openat(jail, "abs/jail/sub/f", 0, 0, RESOLVE_BENEATH))).toBe(EXDEV);
    // A component swapped for a symlink between two requests is resolved again, beneath the held directory.
    send(at.unlinkAt(jail, "sub/f")); send(at.unlinkAt(jail, "sub", AT_REMOVEDIR)); send(at.symlinkAt("..", jail, "sub"));
    expect(failure(at.openat(jail, "sub/outside", O_CREAT | O_WRONLY, 0o644, RESOLVE_BENEATH))).toBe(EXDEV);
    expect(failure(at.statAt(CWD, "/workspace/outside"))).toBe(2);
    // Without RESOLVE_BENEATH the same descriptor resolves as Linux does.
    expect(send(at.statAt(jail, "abs", 0x100)).mode & 0o170000).toBe(0o120000);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("lists a held directory in batches whose d_off cookies resume it after a seek", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    send(at.mkdirAt(CWD, "/workspace/list", 0o755));
    for (const name of ["a", "b", "c", "d"]) send(files.close(send(at.openat(CWD, `/workspace/list/${name}`, O_CREAT | O_WRONLY, 0o644))));
    const dir = send(at.openat(CWD, "/workspace/list", O_DIRECTORY | O_CLOEXEC, 0));
    const all = send(at.getdents(dir, 64 * 1024));
    const names = all.map(entry => text(entry.name)).sort();
    expect(names).toEqual([".", "..", "a", "b", "c", "d"]);
    const second = all[1];
    if (second === undefined) throw new Error("no second entry");
    send(files.seek(dir, second.next, "start"));
    const rest = send(at.getdents(dir, 64 * 1024));
    expect(rest.map(entry => text(entry.name))).toEqual(all.slice(2).map(entry => text(entry.name)));
    expect(send(at.getdents(dir, 64 * 1024))).toEqual([]);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("reads and writes at an offset without moving the description's offset, and sets times on a held descriptor", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    const fd = send(at.openat(CWD, "/workspace/positional", O_CREAT | O_RDWR, 0o644));
    send(files.write(fd, new TextEncoder().encode("0123456789")));
    expect(send(files.seek(fd, 3n, "start"))).toBe(3n);
    expect(text(send(at.pread(fd, 4, 5n)))).toBe("5678");
    expect(send(at.pwrite(fd, new TextEncoder().encode("XY"), 0n))).toBe(2);
    expect(send(files.seek(fd, 0n, "current"))).toBe(3n);
    expect(text(send(files.read(fd, 3)))).toBe("345");
    send(at.utimensAt(fd, "", 1_000_000_123n, 2_000_000_456n, AT_EMPTY_PATH));
    const stat = send(at.statAt(fd, "", AT_EMPTY_PATH));
    expect([stat.accessedNs, stat.modifiedNs]).toEqual([1_000_000_123n, 2_000_000_456n]);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("returns a link target's raw bytes, invalid UTF-8 included", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    const target = Uint8Array.of(0x61, 0xff, 0xfe, 0x62);
    send(at.symlinkAt(target, CWD, "/workspace/raw-link"));
    expect(send(at.readlinkAt(CWD, "/workspace/raw-link"))).toEqual(target);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("polls with a zero timeout and returns readiness once data arrives", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    const [read, write] = send(files.pipe());
    expect(send(at.poll([{ fd: read, events: 1 }], 0)).filter(entry => entry.revents !== 0)).toEqual([]);
    send(files.write(write, Uint8Array.of(7)));
    expect(send(at.poll([{ fd: read, events: 1 }], 1000)).find(entry => entry.fd === read)?.revents ?? 0).toBeGreaterThan(0);
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("reads the VM's clocks and entropy, and refuses unsupported clocks and oversized requests", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    const first = send(clockOperations.now("monotonic")), second = send(clockOperations.now("monotonic"));
    expect(second >= first).toBe(true);
    expect(send(clockOperations.resolution("realtime")) > 0n).toBe(true);
    expect(send(clockOperations.now("realtime")) > 1_600_000_000_000_000_000n).toBe(true);
    expect(send(randomOperation(0))).toEqual(new Uint8Array());
    const bytes = send(randomOperation(65_536));
    expect(bytes.byteLength).toBe(65_536);
    expect(new Set(bytes.subarray(0, 64)).size).toBeGreaterThan(8);
    expect(() => randomOperation(65_537)).toThrow();
  } finally { await f.runtime.jitRuntime.dispose(); }
});

