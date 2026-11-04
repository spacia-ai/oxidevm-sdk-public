import { describe, expect, it } from "vitest";
import type { FileDescriptor } from "../../../js-process-types.js";
import { WASI } from "./errno.js";
import type { ClockHost } from "../../../js-process-types.js";
import type { AtFiles } from "./host.js";
import { GuestMemory } from "./memory.js";
import { encodeLaunch, preview1 } from "./preview1.js";
import { FakeFiles } from "./files.test-support.js";
import { descriptor, streams } from "./streams.test-support.js";

const SUBS = 1024, EVENTS = 4096, COUNT = 8192;

/** A controllable VM clock: tests move it; poll advances it by the timeout it was given, as a real wait would. */
function vmClock(start = 1_000_000_000n) {
  let now = start;
  const clock: ClockHost = { now: () => now, resolution: () => 1000n };
  return { clock, advance: (ns: bigint) => { now += ns; } };
}

function setup(poll: AtFiles["poll"], clock = vmClock()) {
  const files = new FakeFiles({}, ["/workspace"]);
  const at: AtFiles = { ...files.at, poll };
  const fake = streams({ files, clock: clock.clock, random: { fill: bytes => { bytes.fill(7); } } });
  const host = { ...fake.host, at, fs: { ...fake.host.fs, pipe: (): readonly [FileDescriptor, FileDescriptor] => [descriptor(90), descriptor(91)], close: (fd: FileDescriptor) => { if (fd < 90) fake.host.fs.close(fd); } } };
  const memory = new GuestMemory(new WebAssembly.Memory({ initial: 1 }));
  const { imports } = preview1(host, () => memory, { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2) }, encodeLaunch(["t"], {}), { stdin: false, stdout: false, stderr: false });
  const call = (name: string, ...args: readonly (number | bigint)[]): number => {
    const result: unknown = Reflect.apply(imports[name] ?? (() => -1), undefined, args);
    if (typeof result !== "number") throw new Error(name);
    return result;
  };
  const subscribe = (index: number, userdata: bigint, tag: 0 | 1 | 2, value: number | bigint, absolute = false) => {
    const at = SUBS + index * 48;
    memory.write(at, new Uint8Array(48));
    memory.setU64(at, userdata); memory.write(at + 8, Uint8Array.of(tag));
    if (tag === 0) { memory.setU32(at + 16, 1); memory.setU64(at + 24, BigInt(value)); memory.write(at + 40, Uint8Array.of(absolute ? 1 : 0)); }
    else memory.setU32(at + 16, Number(value));
  };
  const events = () => Array.from({ length: memory.u32(COUNT) }, (_, index) => ({
    userdata: memory.u64(EVENTS + index * 32), error: memory.read(EVENTS + index * 32 + 8, 2)[0], type: memory.read(EVENTS + index * 32 + 10, 1)[0],
  }));
  return { call, memory, subscribe, events, clock };
}

describe("clocks (OBL-CLOCK)", () => {
  it("reads the VM's realtime and monotonic clocks and refuses CPU-time clocks", () => {
    const { call, memory } = setup(() => []);
    expect(call("clock_time_get", 1, 0n, 64)).toBe(0);
    expect(memory.u64(64)).toBe(1_000_000_000n);
    expect(call("clock_res_get", 0, 64)).toBe(0);
    expect(memory.u64(64)).toBe(1000n);
    expect(call("clock_time_get", 2, 0n, 64)).toBe(WASI.inval);
    expect(call("clock_res_get", 3, 64)).toBe(WASI.inval);
  });
});

describe("poll_oneoff (OBL-POLL)", () => {
  it("sleeps with one engine wait on a private descriptor, rounding the deadline up to whole ms", () => {
    const waits: { entries: readonly unknown[]; timeout: number }[] = [];
    const time = vmClock();
    const { call, subscribe, events } = setup((entries, timeout) => { waits.push({ entries, timeout }); time.advance(BigInt(timeout) * 1_000_000n); return []; }, time);
    subscribe(0, 42n, 0, 2_500_000n);
    expect(call("poll_oneoff", SUBS, EVENTS, 1, COUNT)).toBe(0);
    expect(waits).toEqual([{ entries: [{ fd: 90, events: 1 }], timeout: 3 }]);
    expect(events()).toEqual([{ userdata: 42n, error: 0, type: 0 }]);
  });

  it("waits for readiness and the nearest deadline together, reporting each ready descriptor's userdata", () => {
    const time = vmClock();
    const { call, subscribe, events } = setup(entries => entries.map(entry => ({ fd: entry.fd, revents: entry.fd === 0 ? 1 | 16 : 0 })), time);
    subscribe(0, 1n, 1, 0); subscribe(1, 2n, 2, 1); subscribe(2, 3n, 0, 5_000_000n);
    expect(call("poll_oneoff", SUBS, EVENTS, 3, COUNT)).toBe(0);
    expect(events()).toEqual([{ userdata: 1n, error: 0, type: 1 }]);
  });

  it("answers an absolute deadline that already passed without waiting", () => {
    const waits: number[] = [];
    const { call, subscribe, events } = setup((_entries, timeout) => { waits.push(timeout); return []; });
    subscribe(0, 9n, 0, 10n, true);
    expect(call("poll_oneoff", SUBS, EVENTS, 1, COUNT)).toBe(0);
    expect(waits).toEqual([0]);
    expect(events()).toEqual([{ userdata: 9n, error: 0, type: 0 }]);
  });

  it("refuses 0 and 17 subscriptions before any host work, and gives a bad descriptor its own error", () => {
    let polls = 0;
    const { call, subscribe, events } = setup(() => { polls += 1; return []; });
    expect(call("poll_oneoff", SUBS, EVENTS, 0, COUNT)).toBe(WASI.inval);
    expect(call("poll_oneoff", SUBS, EVENTS, 17, COUNT)).toBe(WASI.inval);
    subscribe(0, 5n, 1, 77);
    expect(call("poll_oneoff", SUBS, EVENTS, 1, COUNT)).toBe(0);
    expect(events()).toEqual([{ userdata: 5n, error: WASI.badf, type: 1 }]);
    expect(polls).toBe(0);
  });
});

describe("random_get (OBL-RANDOM)", () => {
  it("fills 0, 65536 and multi-chunk lengths from the VM and refuses a range outside memory", () => {
    const { call, memory } = setup(() => []);
    expect(call("random_get", 100, 0)).toBe(0);
    expect(call("random_get", 0, 65536)).toBe(0);
    expect(memory.read(65535, 1)).toEqual(Uint8Array.of(7));
    expect(call("random_get", 65000, 1000)).toBe(WASI.fault);
  });
});
