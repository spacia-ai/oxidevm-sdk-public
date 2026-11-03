import { afterEach, describe, expect, it, vi } from "vitest";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION, LinuxError, Writer } from "../../runtime/js-process/codec.js";
import { dispositionOperation, SIGNAL_BUFFER_BYTES } from "../../runtime/js-process/signals.js";
import { LinuxClient } from "../../runtime/js-process/transport.js";
import { record } from "../../runtime/decode.js";
import { clientSignals } from "./browser.js";
import { COMMAND_DECLARATION, buildRelease } from "./fixtures.test-support.js";
import { launch } from "./harness.test-support.js";
import { fakeSignals } from "../testing/memory-signals.js";
import { RunnerSignals } from "./signals.js";

afterEach(() => { vi.restoreAllMocks(); });

/** Calls `member` of `api` with an argument its type would not allow, as an adapter written in JavaScript can. */
async function untyped(api: object, member: string, input: unknown): Promise<unknown> {
  const method: unknown = Reflect.get(api, member);
  if (typeof method !== "function") throw new Error(`no ${member}`);
  const result: unknown = await Reflect.apply(method, api, [input]);
  return result;
}

/** Flushes the microtasks a settled promise would have run. */
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); };

describe("OXJR 65550, a trappable signal's host disposition", () => {
  it("asks for the interrupt flag without restart when it catches, and nothing else", () => {
    expect(Array.from(dispositionOperation(2, "caught").payload)).toEqual([2, 2, 0b10]);
    expect(Array.from(dispositionOperation(15, "ignore").payload)).toEqual([15, 1, 0]);
    expect(Array.from(dispositionOperation(1, "default").payload)).toEqual([1, 0, 0]);
    expect(dispositionOperation(2, "caught").number).toBe(65550);
  });

  it("decodes the previous disposition from the reply's value and refuses anything else", () => {
    const operation = dispositionOperation(2, "caught");
    expect([0n, 1n, 2n].map(value => operation.decode({ value, bytes: new Uint8Array() }))).toEqual(["default", "ignore", "caught"]);
    expect(() => operation.decode({ value: 3n, bytes: new Uint8Array() })).toThrow();
    expect(() => operation.decode({ value: 0n, bytes: Uint8Array.of(0) })).toThrow();
  });
});

describe("host.process.signals", () => {
  it("resolves trap once Rust installed every caught disposition, lowest signal first", async () => {
    const transport = fakeSignals({ deferred: true }), signals = new RunnerSignals(transport);
    let resolved = false;
    const trapping = signals.api.trap(["SIGTERM", "SIGINT"]).then(trap => { resolved = true; return trap; });
    await settle();
    expect(transport.calls).toEqual([[2, "caught"]]);
    expect(resolved).toBe(false);
    transport.release();
    await settle();
    expect(transport.calls).toEqual([[2, "caught"], [15, "caught"]]);
    expect(resolved).toBe(false);
    transport.release();
    const trap = await trapping;
    expect(trap.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(Object.isFrozen(trap.signals)).toBe(true);
    // The adapter holds only the trap's public members.
    expect(Object.isFrozen(trap)).toBe(true);
    expect(Object.keys(trap).sort()).toEqual(["interruptBuffer", "signals", "untrap"]);
  });

  it("iterates the signals drained from word 0, each once and lowest first, and keeps a pending one pending once", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap(["SIGINT", "SIGTERM", "SIGUSR1"]);
    transport.deliver([2, 15]);
    transport.deliver([2]);
    transport.deliver([10]);
    const iterator = trap[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: "SIGINT", done: false });
    expect(await iterator.next()).toEqual({ value: "SIGTERM", done: false });
    expect(await iterator.next()).toEqual({ value: "SIGUSR1", done: false });
    // A waiting iteration gets the next delivery; a signal no trap holds is dropped.
    const waiting = iterator.next();
    transport.deliver([1, 15]);
    expect(await waiting).toEqual({ value: "SIGTERM", done: false });
    expect(transport.listeners).toBe(1);
  });

  it("exposes the interrupt word (byte 8 of the signal buffer, JS process protocol 5) as the interrupt buffer in Pyodide's format", async () => {
    const transport = fakeSignals(), trap = await new RunnerSignals(transport).api.trap(["SIGINT"]);
    expect(trap.interruptBuffer.buffer).toBe(transport.interruptWord.buffer);
    expect([trap.interruptBuffer.byteOffset, trap.interruptBuffer.length]).toEqual([8, 1]);
    Atomics.store(transport.interruptWord, 0, 2);
    expect(trap.interruptBuffer[0]).toBe(2);
  });

  it("untrap restores the default, drops pending signals and the interrupt it holds, and ends iteration", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap(["SIGINT"]), other = await signals.api.trap(["SIGTERM"]);
    // One listener serves the process, however many traps it has.
    expect(transport.listeners).toBe(1);
    transport.deliver([2]);
    Atomics.store(transport.interruptWord, 0, 2);
    const iterator = trap[Symbol.asyncIterator]();
    await trap.untrap();
    expect(transport.calls.at(-1)).toEqual([2, "default"]);
    expect(Atomics.load(transport.interruptWord, 0)).toBe(0);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    // Untrapping twice changes nothing, and the signal can be trapped again; other traps are untouched.
    const calls = transport.calls.length;
    await trap.untrap();
    expect(transport.calls).toHaveLength(calls);
    transport.deliver([15]);
    expect(await other[Symbol.asyncIterator]().next()).toEqual({ value: "SIGTERM", done: false });
    await expect(signals.api.trap(["SIGINT"])).resolves.toMatchObject({ signals: ["SIGINT"] });
  });

  it("raise delivers a trapped signal to its trap, and ends the process killed by an untrapped or just-untrapped one without settling", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap(["SIGINT"]);
    await signals.api.raise("SIGINT");
    expect(await trap[Symbol.asyncIterator]().next()).toEqual({ value: "SIGINT", done: false });
    expect(transport.exits).toEqual([]);
    await trap.untrap();
    let settled = false;
    void signals.api.raise("SIGINT").finally(() => { settled = true; });
    await settle();
    expect(transport.exits).toEqual([2]);
    expect(settled).toBe(false);
    void signals.api.raise("SIGTERM").finally(() => { settled = true; });
    await settle();
    expect(transport.exits).toEqual([2, 15]);
    expect(settled).toBe(false);
  });

  it("leaves a signal the process inherited as ignored alone: raise does nothing and trap does not take it", async () => {
    const transport = fakeSignals({ ignored: [1] }), signals = new RunnerSignals(transport);
    await signals.api.raise("SIGHUP");
    expect(transport.exits).toEqual([]);
    const trap = await signals.api.trap(["SIGHUP", "SIGINT"]);
    expect(trap.signals).toEqual(["SIGINT"]);
    expect(transport.calls.slice(-3)).toEqual([[1, "caught"], [1, "ignore"], [2, "caught"]]);
    expect(transport.dispositions.get(1)).toBe("ignore");
  });

  it("refuses a second trap of a trapped signal, untrappable signals and malformed lists before changing anything", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    await signals.api.trap(["SIGINT"]);
    const calls = transport.calls.length;
    const refused = { code: "INVALID_ARGUMENT" };
    await expect(signals.api.trap(["SIGTERM", "SIGINT"])).rejects.toMatchObject(refused);
    for (const input of [[], ["SIGKILL"], ["SIGSTOP"], ["SIGTERM", "SIGTERM"], ["sigterm"], "SIGTERM", [2], undefined]) {
      await expect(untyped(signals.api, "trap", input), JSON.stringify(input)).rejects.toMatchObject(refused);
    }
    for (const input of ["SIGKILL", 2, undefined]) await expect(untyped(signals.api, "raise", input)).rejects.toMatchObject(refused);
    expect(transport.calls).toHaveLength(calls);
    expect(transport.exits).toEqual([]);
  });

  it("restores what a failed trap installed and refuses it", async () => {
    const transport = fakeSignals({ refuse: [15] }), signals = new RunnerSignals(transport);
    await expect(signals.api.trap(["SIGINT", "SIGTERM"])).rejects.toBeInstanceOf(LinuxError);
    expect(transport.dispositions.get(2)).toBe("default");
    transport.refused.clear();
    await expect(signals.api.trap(["SIGINT", "SIGTERM"])).resolves.toMatchObject({ signals: ["SIGINT", "SIGTERM"] });
  });

  it("is untrapped by the runner when the module ends, and is absent unless declared", async () => {
    const adapter = `export default async host => {
      host.log("signals=" + ("signals" in host.process));
      await host.process.signals.trap(["SIGTERM", "SIGINT"]);
      return { main: () => 0 };
    };`;
    const release = await buildRelease({ adapter, declaration: { ...COMMAND_DECLARATION, requires: { host: ["process.signals"] } } });
    const transport = fakeSignals(), running = launch({ release, signals: transport });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.stderrLines).toEqual(["signals=true"]);
    expect(transport.dispositions).toEqual(new Map([[2, "default"], [15, "default"]]));
    expect(transport.calls.slice(-2)).toEqual([[2, "default"], [15, "default"]]);
  });

  it("binds to the process's Linux client: dispositions travel as OXJR 65550 and nudged signals reach the trap", async () => {
    const channel = new MessageChannel(), words = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES), driver = channel.port2;
    const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), words), requests: unknown[] = [];
    driver.onmessage = (event: MessageEvent<unknown>) => {
      const request = record(event.data, "request"); requests.push(request);
      // Rust's answer to OXJR 65550: the previous disposition, the default here.
      if (request["type"] === "request") driver.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: request["sequence"], errno: 0, value: 0n, payload: new Uint8Array() });
    };
    try {
      const signals = new RunnerSignals(clientSignals(client)), trap = await signals.api.trap(["SIGINT"]);
      expect(requests).toMatchObject([{ type: "request", operation: 65550, payload: Uint8Array.of(2, 2, 0b10) }]);
      // What the driver does for a notice: the pending bit, then a nudge.
      Atomics.or(new Int32Array(words), 0, 1 << 1);
      driver.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
      expect(await trap[Symbol.asyncIterator]().next()).toEqual({ value: "SIGINT", done: false });
      expect(trap.interruptBuffer.buffer).toBe(words);
      await trap.untrap();
      // raise asks Rust for the process's pid first (OXJR 65537); its kill follows in the masks suite.
      void signals.api.raise("SIGINT").catch(() => undefined);
      await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ type: "request", operation: 65537 }));
    } finally { client.dispose(); driver.close(); }
  });
});

describe("host.process.signals masks (OXJR 14 and 127) and raise as kill(getpid())", () => {
  it("block and unblock answer the previous mask, pending the blocked pending set, through Rust's operations", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    expect(await signals.api.block(["SIGINT"])).toEqual(new Set());
    expect(transport.masks).toEqual([["block", 1n << 1n]]);
    expect(await signals.api.block(["SIGTERM", "SIGUSR1"])).toEqual(new Set(["SIGINT"]));
    const trap = await signals.api.trap(["SIGINT"]);
    await signals.api.raise("SIGINT");
    expect(await signals.api.pending()).toEqual(new Set(["SIGINT"]));
    // Unblocking a pending trapped signal delivers it once.
    expect(await signals.api.unblock(["SIGINT"])).toEqual(new Set(["SIGINT", "SIGTERM", "SIGUSR1"]));
    expect(await trap[Symbol.asyncIterator]().next()).toEqual({ value: "SIGINT", done: false });
    expect(await signals.api.pending()).toEqual(new Set());
  });

  it("raise is kill(getpid(), signal): a trapped signal reaches its trap through Rust, an untrapped one takes its default action without settling", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap(["SIGUSR1"]);
    await signals.api.raise("SIGUSR1");
    expect(transport.kills).toEqual([10]);
    expect(await trap[Symbol.asyncIterator]().next()).toEqual({ value: "SIGUSR1", done: false });
    await trap.untrap();
    let settled = false;
    void signals.api.raise("SIGUSR1").finally(() => { settled = true; });
    await settle();
    expect(transport.exits).toEqual([10]);
    expect(settled).toBe(false);
  });

  it("refuses SIGKILL, SIGSTOP, unknown names and malformed lists before asking Rust", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport), refused = { code: "INVALID_ARGUMENT" };
    for (const member of ["block", "unblock"]) for (const input of [["SIGKILL"], ["SIGSTOP"], ["SIGNOPE"], "SIGINT", [33], undefined]) {
      await expect(untyped(signals.api, member, input), `${member} ${JSON.stringify(input)}`).rejects.toMatchObject(refused);
    }
    expect(transport.masks).toEqual([]);
  });

  it("travels as OXJR 14 {u8 how, u64 set} and 127, and raise as OXJR 62 to the process's own pid", async () => {
    const channel = new MessageChannel(), driver = channel.port2, requests: Readonly<Record<string, unknown>>[] = [];
    const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), new SharedArrayBuffer(SIGNAL_BUFFER_BYTES));
    driver.onmessage = (event: MessageEvent<unknown>) => {
      const request = record(event.data, "request"); requests.push(request);
      const info = request["operation"] === 65537;
      // Process info: pid 7, parent 1, uid and gid 1000, no terminal, cwd "/", no arguments or environment.
      const payload = info ? new Writer().u32(7).u32(1).u32(1000).u32(1000).raw(new Uint8Array(4)).blob(new TextEncoder().encode("/")).u32(0).u32(0).finish() : new Uint8Array();
      driver.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: request["sequence"], errno: 0, value: request["operation"] === 14 ? 4n : 0n, payload });
    };
    try {
      const signals = new RunnerSignals(clientSignals(client));
      expect(await signals.api.block(["SIGINT", "SIGRTMIN"])).toEqual(new Set(["SIGQUIT"]));
      expect(requests.at(-1)).toMatchObject({ operation: 14, payload: new Writer().u8(0).u64((1n << 1n) | (1n << 34n)).finish() });
      await signals.api.unblock(["SIGINT"]);
      expect(requests.at(-1)).toMatchObject({ operation: 14, payload: new Writer().u8(1).u64(1n << 1n).finish() });
      expect(await signals.api.pending()).toEqual(new Set());
      expect(requests.at(-1)).toMatchObject({ operation: 127, payload: new Uint8Array() });
      await signals.api.raise("SIGUSR2");
      expect(requests.slice(-2)).toMatchObject([{ operation: 65537 }, { operation: 62, payload: new Writer().u32(7).u8(12).finish() }]);
    } finally { client.dispose(); driver.close(); }
  });
});
