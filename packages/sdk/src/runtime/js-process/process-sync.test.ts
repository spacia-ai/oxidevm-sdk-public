import { describe, expect, it } from "vitest";
import type { NativeSyncRunSpec } from "../../js-process-types.js";
import { decodeProcessId } from "../../values.js";
import { LinuxError, Reader, type LinuxOperation, type LinuxResult } from "./codec.js";
import { processSync, RUN_SYNC_LIMITS, runSync } from "./process-sync.js";

const empty = (value = 0n): LinuxResult => ({ value, bytes: new Uint8Array() });
const STDIN = 10, STDOUT = 11, STDERR = 12, PID = 77;

/**
 * Rust and one child, played by the test: the child echoes what it reads from stdin to stdout (at most `capacity` bytes
 * in flight), writes `stderr` at once, and exits with `status` when its input ends. `stall` makes it never end its
 * output (a descendant holding the pipe); the monotonic clock moves only when a poll waits.
 */
class Child {
  readonly log: string[] = [];
  readonly spawns: Reader[] = [];
  clock = 5_000_000n;
  received: number[] = [];
  stdout: number[] = [];
  stderr: number[];
  inputClosed = false;
  outputClosed = new Set<number>();
  killed = false;
  polls = 0;
  constructor(readonly options: { readonly stderr?: number[]; readonly status?: number; readonly stall?: boolean; readonly flood?: number; readonly noReader?: boolean } = {}) {
    this.stderr = [...options.stderr ?? []];
    if (options.flood !== undefined) this.stdout = Array.from({ length: options.flood }, () => 0x61);
  }
  /** An output ends once the child was killed, or once its input ended unless it stalls. */
  #ended(): boolean { return this.killed || (this.inputClosed && this.options.stall !== true); }
  sync<T>(operation: LinuxOperation<T>): T {
    const reader = new Reader(operation.payload);
    return operation.decode(this.#answer(operation.number, reader));
  }
  #answer(number: number, reader: Reader): LinuxResult {
    this.log.push(String(number));
    switch (number) {
      case 228: reader.u32(); return empty(this.clock);
      case 65538: { this.spawns.push(reader); const bytes = new Uint8Array(12), view = new DataView(bytes.buffer); view.setInt32(0, STDIN, true); view.setInt32(4, STDOUT, true); view.setInt32(8, STDERR, true); return { value: BigInt(PID), bytes }; }
      case 72: { reader.u64(); const command = reader.u32(); if (command === 4) reader.u64(); return empty(command === 3 ? 2n : 0n); }
      case 65552: return this.#poll(reader);
      case 1: {
        reader.u64(); const bytes = Array.from(reader.blob());
        if (this.options.noReader === true) throw new LinuxError(32);
        this.received.push(...bytes); this.stdout.push(...bytes); return empty(BigInt(bytes.length));
      }
      case 0: {
        const fd = Number(reader.u64()), count = Number(reader.u64()), queue = fd === STDOUT ? this.stdout : this.stderr;
        if (queue.length === 0) { if (this.#ended()) return empty(); throw new LinuxError(11); }
        const bytes = Uint8Array.from(queue.splice(0, count)); return { value: BigInt(bytes.length), bytes };
      }
      case 3: { const fd = Number(reader.u64()); this.log.push(`close ${String(fd)}`); if (fd === STDIN) this.inputClosed = true; else this.outputClosed.add(fd); return empty(); }
      case 62: { reader.u32(); const signal = reader.u8(); this.log.push(`kill ${String(signal)}`); if (signal === 9) this.killed = true; return empty(); }
      case 61: reader.u32(); this.log.push("wait"); return empty(BigInt(this.killed ? 9 : (this.options.status ?? 0) << 8));
      default: throw new Error(`unexpected operation ${String(number)}`);
    }
  }
  #poll(reader: Reader): LinuxResult {
    const count = reader.u32(), entries = Array.from({ length: count }, () => ({ fd: Number(reader.u64()), events: reader.u32() }));
    const timeout = BigInt.asIntN(64, reader.u64()); reader.end();
    this.log.push(`poll ${entries.map(entry => String(entry.fd)).join(",")} ${String(timeout)}`);
    // A run that keeps polling past any deadline is the defect under test, not a reason to hang the suite.
    if (++this.polls > 1000) throw new Error("runSync kept polling past its deadline");
    const revents = entries.map(({ fd, events }) => {
      if (fd === STDIN) return this.options.noReader === true ? 4 | 8 : events & 4;
      const queue = fd === STDOUT ? this.stdout : this.stderr;
      return queue.length > 0 || this.#ended() ? 1 : 0;
    });
    const ready = revents.filter(value => value !== 0).length;
    if (ready === 0) { if (timeout < 0n) throw new Error("an infinite poll in a timed run"); this.clock += timeout * 1_000_000n; }
    const bytes = new Uint8Array(count * 8), view = new DataView(bytes.buffer);
    entries.forEach((entry, index) => { view.setInt32(index * 8, entry.fd, true); view.setUint16(index * 8 + 4, entry.events, true); view.setUint16(index * 8 + 6, revents[index] ?? 0, true); });
    return { value: BigInt(ready), bytes };
  }
}

const spec = (overrides: Partial<NativeSyncRunSpec> = {}): NativeSyncRunSpec => ({ command: "/bin/cat", args: ["-"], input: new TextEncoder().encode("hello"), timeoutMs: 1000, stdoutLimit: 1024, stderrLimit: 1024, ...overrides });
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
function thrown(action: () => unknown): unknown { try { action(); } catch (error: unknown) { return error; } return undefined; }

describe("runSync", () => {
  it("feeds input, drains both outputs, reaps the owned child and returns its exit", () => {
    const child = new Child({ stderr: [0x77], status: 3 });
    const result = runSync(child, spec());
    expect({ pid: result.pid, exit: result.exit, stdout: text(result.stdout), stderr: text(result.stderr) }).toEqual({ pid: PID, exit: { kind: "exited", code: 3 }, stdout: "hello", stderr: "w" });
    expect(child.received).toEqual(Array.from(new TextEncoder().encode("hello")));
    // The spawn asked for three pipes and an owned child (flag bit 64), with the environment and directory inherited.
    const payload = child.spawns[0];
    expect(payload?.text()).toBe("/bin/cat"); expect(payload?.strings()).toEqual(["-"]);
    expect(payload?.u8()).toBe(0); expect(payload?.u8()).toBe(0); expect(payload?.u8()).toBe(1 | 2 | 4 | 64); payload?.end();
    expect(child.log.filter(entry => entry.startsWith("kill"))).toEqual([]);
    expect(child.log.at(-1)).toBe("wait");
    // Every wait is bounded by what remains of the deadline (1000 ms), never infinite.
    expect(child.log.filter(entry => entry.startsWith("poll")).every(entry => /\s(?:[1-9]\d*)$/u.test(entry))).toBe(true);
  });

  it("ends a run whose output never ends at its deadline: killed, reaped, then ETIMEDOUT", () => {
    const child = new Child({ stall: true });
    const error = thrown(() => runSync(child, spec({ timeoutMs: 250 })));
    expect(error).toBeInstanceOf(LinuxError);
    expect(error).toMatchObject({ errno: 110 });
    expect(child.log).toContain("kill 9");
    expect(child.log.indexOf("kill 9")).toBeLessThan(child.log.lastIndexOf("wait"));
    expect(child.log.filter(entry => entry.startsWith("close"))).toEqual(["close 10", "close 11", "close 12"]);
    // The clock moved by exactly the deadline: 250 ms of waiting, in at most a few polls.
    expect(child.clock - 5_000_000n).toBe(250_000_000n);
  });

  it("stops at an output limit: killed, reaped, then E2BIG; the limit applies to each stream", () => {
    const child = new Child({ flood: 2048 });
    expect(thrown(() => runSync(child, spec({ input: new Uint8Array(), stdoutLimit: 1000 })))).toMatchObject({ errno: 7 });
    expect(child.log).toContain("kill 9");
    expect(child.log.at(-1)).toBe("wait");
    const exact = new Child({ flood: 1000 });
    expect(runSync(exact, spec({ input: new Uint8Array(), stdoutLimit: 1000 })).stdout).toHaveLength(1000);
  });

  it("stops feeding a child that does not read its input instead of writing into a closed pipe", () => {
    const child = new Child({ noReader: true });
    const result = runSync(child, spec());
    expect(result.exit).toEqual({ kind: "exited", code: 0 });
    expect(child.log).not.toContain("1");
    expect(child.log).toContain("close 10");
  });

  it("refuses an invalid run with INVALID_ARGUMENT before anything is spawned", () => {
    const invalid: readonly Partial<NativeSyncRunSpec>[] = [
      { command: "cat" }, { command: "/bin/c\0at" }, { args: Array.from({ length: RUN_SYNC_LIMITS.arguments }, () => "x") }, { args: ["a\0"] },
      { input: new Uint8Array(RUN_SYNC_LIMITS.inputBytes + 1) }, { timeoutMs: 0 }, { timeoutMs: 180_001 }, { timeoutMs: 1.5 },
      { stdoutLimit: RUN_SYNC_LIMITS.outputBytes + 1 }, { stderrLimit: -1 }, { cwd: "/a\0" }, { env: { "A=B": "c" } }, { env: { A: "b\0" } }, { cwd: "x".repeat(4096) },
    ];
    for (const overrides of invalid) {
      const child = new Child();
      expect(thrown(() => runSync(child, spec(overrides))), JSON.stringify(Object.keys(overrides))).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(child.log.filter(entry => entry === "65538")).toEqual([]);
    }
    expect(() => runSync(new Child(), spec({ args: Array.from({ length: RUN_SYNC_LIMITS.arguments - 1 }, () => "x") }))).not.toThrow();
  });
});

describe("processSync", () => {
  it("sends spawn, wait, signal and info synchronously, with the owned flag only when asked", () => {
    const child = new Child({ status: 1 });
    const sync = processSync(child);
    expect(Object.isFrozen(sync)).toBe(true);
    const spawned = sync.spawnSync({ command: "/bin/true", owned: true });
    expect(spawned).toEqual({ pid: PID, stdin: STDIN, stdout: STDOUT, stderr: STDERR });
    sync.spawnSync({ command: "/bin/true" });
    const [owned, plain] = child.spawns;
    for (const reader of [owned, plain]) { reader?.text(); reader?.strings(); reader?.u8(); reader?.u8(); }
    expect(owned?.u8()).toBe(64); expect(plain?.u8()).toBe(0);
    expect(sync.waitSync(decodeProcessId(PID))).toEqual({ kind: "exited", code: 1 });
    sync.signalSync(decodeProcessId(PID), 15);
    expect(child.log).toContain("kill 15");
  });
});
