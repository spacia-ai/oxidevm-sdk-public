import { afterEach, describe, expect, it, vi } from "vitest";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION, Writer } from "../../js-process/codec.js";
import { MODULE_BROKER_VERSION, MODULE_FRAME_BOOTSTRAP_VERSION } from "../../protocol/module-frame.js";
import { ModuleBroker, refuseBeyondReach, serveBrokerControl } from "./broker.js";
import { brokerWith, FakeRunner, KEY, launch, next, reply, request, spawn, WASM } from "./broker.test-support.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the module frame's broker (ADR 0028)", () => {
  it("async relay into its own mailbox", async () => {
    const { port, runners } = brokerWith(), process = await spawn(port, runners);
    expect(process.start).toMatchObject({ version: JS_PROCESS_PROTOCOL_VERSION, type: "start" });
    const upstream = next(process.service), notice = next(process.notices);
    process.port.postMessage(request(1, true));
    // The Userspace worker receives the same bounded request asynchronously, and one attention notice for it.
    expect(await upstream).toMatchObject({ sequence: 1, sync: false, operation: 1 });
    expect(await notice).toBeNull();
    process.service.postMessage(reply(1));
    await vi.waitFor(() => { expect(Atomics.load(process.header, 0)).toBe(1); });
    expect([Atomics.load(process.header, 2), process.mailbox.byteLength]).toEqual([1, JS_MAILBOX_BYTES]);
  });

  it("notice before nudge", async () => {
    const { port, runners } = brokerWith(), process = await spawn(port, runners);
    process.port.postMessage(request(1, true));
    await next(process.service);
    // SIGINT's notice travels on the service port, which is ordered, ahead of the completion it interrupted. The broker
    // applies it whole as it arrives: pending bit and interrupt word first, then the nudge; the mailbox is untouched.
    const nudge = next(process.port);
    process.service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: 2, interrupt: true, code: 0, sender: 1, uid: 1000, value: 0n });
    expect(await nudge).toEqual({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    expect([Atomics.load(process.words, 0), Atomics.load(process.words, 2), Atomics.load(process.header, 0)]).toEqual([1 << 1, 2, 0]);
    process.service.postMessage(reply(1));
    await vi.waitFor(() => { expect(Atomics.load(process.header, 0)).toBe(1); });
  });

  it("interrupt only while the interrupt word (byte 8) is 0", async () => {
    const { port, runners } = brokerWith(), process = await spawn(port, runners);
    // The module has not taken the previous interrupt yet: SIGTERM must wait.
    Atomics.store(process.words, 2, 2);
    process.service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: 15, interrupt: true, code: 0, sender: 1, uid: 1000, value: 0n });
    await vi.waitFor(() => { expect(Atomics.load(process.words, 0) & (1 << 14)).not.toBe(0); });
    expect(Atomics.load(process.words, 2)).toBe(2);
    Atomics.store(process.words, 2, 0);
    await vi.waitFor(() => { expect(Atomics.load(process.words, 2)).toBe(15); });
  });

  it("a real-time notice reaches the process's ring with its details; a notice without them fails only its process", async () => {
    const { port, runners } = brokerWith(), process = await spawn(port, runners), nudge = next(process.port);
    process.service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: 36, interrupt: false, code: -1, sender: 41, uid: 1000, value: 0x1234n });
    expect(await nudge).toEqual({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    const ring = new DataView(process.words.buffer);
    expect([ring.getUint32(12, true), ring.getInt32(32, true), ring.getInt32(36, true), ring.getUint32(40, true), ring.getUint32(44, true), ring.getBigUint64(48, true)]).toEqual([1, 36, -1, 41, 1000, 0x1234n]);
    const failure = next(process.channel);
    process.service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: 37, interrupt: false });
    expect(await failure).toMatchObject({ type: "error" });
  });

  it("an out-of-sequence request fails only its process", async () => {
    const { port, runners } = brokerWith(), hostile = await spawn(port, runners, 7), healthy = await spawn(port, runners, 8);
    const failure = next(hostile.channel);
    hostile.port.postMessage(request(2, true));
    expect(await failure).toEqual({ version: MODULE_BROKER_VERSION, type: "error", message: "Relayed Linux request out of sequence" });
    expect(hostile.runner.terminated).toBe(true);
    // Forged fields and messages that are not requests at all fail the same way, never the broker.
    healthy.port.postMessage(request(1, false));
    expect(await next(healthy.service)).toMatchObject({ sequence: 1 });
    expect(healthy.runner.terminated).toBe(false);
    const third = await spawn(port, runners, 9), refused = next(third.channel);
    third.port.postMessage({ ...request(1, true), extra: 1 });
    expect(await refused).toMatchObject({ type: "error" });
  });

  it("a runner message that cannot be forwarded fails only its process", async () => {
    // Found by the escape suite (tests/browser/module-isolation.ts): a runner posting a MessagePort it did not transfer
    // made the broker's forward throw outside any handler; the frame then ended the broker and every module process.
    const { port, runners } = brokerWith(), hostile = await spawn(port, runners, 7), healthy = await spawn(port, runners, 8);
    const failure = next(hostile.channel), stray = new MessageChannel();
    hostile.runner.onmessage?.(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "request", port: stray.port1 } }));
    expect(await failure).toMatchObject({ version: MODULE_BROKER_VERSION, type: "error" });
    expect(hostile.runner.terminated).toBe(true);
    healthy.port.postMessage(request(1, false));
    expect(await next(healthy.service)).toMatchObject({ sequence: 1 });
    expect(healthy.runner.terminated).toBe(false);
    stray.port1.close(); stray.port2.close();
  });

  it("a retained module compiles once", async () => {
    const { port, runners, compile } = brokerWith(), first = await spawn(port, runners, 7), second = await spawn(port, runners, 8);
    const moduleOf = (start: Readonly<Record<string, unknown>>): unknown => Reflect.get(Reflect.get(Reflect.get(Object(start["launch"]), "artifacts"), "tool.wasm"), "module");
    expect(moduleOf(first.start)).toBeInstanceOf(WebAssembly.Module);
    expect(moduleOf(second.start)).toBe(moduleOf(first.start));
    expect(compile).toHaveBeenCalledOnce();
  });

  it("refuses a start that carries a compiled module or keys that are not the launch's", async () => {
    const { port, runners } = brokerWith();
    for (const value of [
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch: { ...launch(), artifacts: { "tool.wasm": { blob: new Blob([WASM]), module: await WebAssembly.compile(WASM) } } }, keys: { "tool.wasm": KEY }, tls: null, reach: 0 },
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch: launch(), keys: {}, tls: null, reach: 0 },
      { version: JS_PROCESS_PROTOCOL_VERSION - 1, type: "start", launch: launch(), keys: { "tool.wasm": KEY }, tls: null, reach: 0 },
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch: launch(), keys: { "tool.wasm": KEY }, tls: KEY, reach: 1 },
      { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch: launch(), keys: { "tool.wasm": KEY }, tls: null, reach: 3 },
    ]) {
      const channel = new MessageChannel(), service = new MessageChannel(), failure = next(channel.port1);
      port.postMessage({ version: MODULE_BROKER_VERSION, type: "spawn", pid: 3, port: channel.port2 }, [channel.port2]);
      channel.port1.postMessage({ version: MODULE_BROKER_VERSION, type: "start", value, port: service.port2, attention: null }, [service.port2]);
      expect(await failure).toMatchObject({ version: MODULE_BROKER_VERSION, type: "error" });
    }
    expect(runners).toHaveLength(0);
  });

  it("the page's heartbeat is answered by the broker itself, so a broker that dies (out of memory) stops answering", async () => {
    const control = new MessageChannel(), attached = new MessageChannel(), liveness = new MessageChannel();
    const broker = new ModuleBroker({ startRunner: () => new FakeRunner() });
    const stop = serveBrokerControl(control.port2, broker);
    control.port1.postMessage({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "attach", port: attached.port2, liveness: liveness.port2 }, [attached.port2, liveness.port2]);
    const pong = next(liveness.port1);
    liveness.port1.postMessage("ping");
    expect(await pong).toBe("pong");
    // A broker that is gone answers nothing: the page's watch then ends the module processes (status 125) and reopens.
    stop();
    let answered = false;
    liveness.port1.onmessage = () => { answered = true; };
    liveness.port1.postMessage("ping");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(answered).toBe(false);
  });

  it("refuses an attachment without its heartbeat port", () => {
    const control = new MessageChannel(), attached = new MessageChannel();
    const errors: unknown[] = [];
    serveBrokerControl(control.port2, new ModuleBroker({ startRunner: () => new FakeRunner() }), error => { errors.push(error); });
    control.port1.postMessage({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "attach", port: attached.port2 }, [attached.port2]);
    return vi.waitFor(() => { expect(errors).toEqual([expect.objectContaining({ code: "PROTOCOL_ERROR" })]); });
  });

  it("checks the reach before Rust: a module without one opens no connection and sends no datagram (ADR 0029)", () => {
    const address = new Writer().u64(3).blob(Uint8Array.of(2, 0, 0, 80, 93, 184, 215, 14, 0, 0, 0, 0, 0, 0, 0, 0)).finish();
    const sendTo = new Writer().u64(3).blob(Uint8Array.of(1)).u64(0x4000).blob(Uint8Array.of(2, 0, 0, 53, 10, 0, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0)).finish();
    const write = new Writer().u64(3).blob(Uint8Array.of(1)).u64(0x4000).finish();
    expect([refuseBeyondReach(0, 42, address), refuseBeyondReach(0, 44, sendTo), refuseBeyondReach(0, 44, write), refuseBeyondReach(0, 49, address)]).toEqual([13, 13, undefined, undefined]);
    for (const reach of [1, 2] as const) expect([refuseBeyondReach(reach, 42, address), refuseBeyondReach(reach, 44, sendTo)]).toEqual([undefined, undefined]);
  });

  it("answers a refused request itself, synchronously in the mailbox, and never forwards it", async () => {
    const { port, runners } = brokerWith(), process = await spawn(port, runners);
    let forwarded = false;
    process.service.addEventListener("message", () => { forwarded = true; });
    process.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: true, operation: 42, payload: new Writer().u64(3).blob(Uint8Array.of(1, 0, 47, 0)).finish() });
    await vi.waitFor(() => { expect(Atomics.load(process.header, 0)).toBe(1); });
    expect(new DataView(process.mailbox, 16).getUint32(0, true)).toBe(13);
    expect(forwarded).toBe(false);
  });

  it("keeps the Userspace worker's request sequence whole after a refused request, and maps the reply back", async () => {
    // A service without a reach probes a leftover socket with connect(2) before it binds: the broker answers that request
    // itself, so the next request the Userspace worker sees must still be its next in sequence (it ends a process whose
    // requests skip one), and its reply must reach the process under the process's own sequence.
    const { port, runners } = brokerWith(), process = await spawn(port, runners);
    process.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence: 1, sync: true, operation: 42, payload: new Writer().u64(3).blob(Uint8Array.of(1, 0, 47, 0)).finish() });
    await vi.waitFor(() => { expect(Atomics.load(process.header, 0)).toBe(1); });
    const upstream = next(process.service), answered = next(process.port);
    process.port.postMessage(request(2, false));
    expect(await upstream).toMatchObject({ sequence: 1, sync: false, operation: 1 });
    process.service.postMessage(reply(1));
    expect(await answered).toMatchObject({ type: "reply", sequence: 2, errno: 0, value: 5n });
    const third = next(process.service);
    process.port.postMessage(request(3, true));
    expect(await third).toMatchObject({ sequence: 2, sync: false });
    process.service.postMessage(reply(2));
    await vi.waitFor(() => { expect(Atomics.load(process.header, 2)).toBe(3); });
  });
});
