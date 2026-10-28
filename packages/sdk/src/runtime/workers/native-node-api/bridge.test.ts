import { expect, it } from "vitest";
import { NativeBridge } from "./bridge.js";
import { encodeNativeFrame, type NativeFrame } from "./codec.js";

const readMin = Math.min;

function fixture(frames: readonly NativeFrame[], poll = false, uncaught?: (error: unknown) => void, deferException = false,
  options: { readonly readSize?: number; readonly merged?: boolean; readonly waitForAbort?: boolean; readonly runtime?: "node" | "bun" } = {}) {
  const encoded = frames.map(encodeNativeFrame), merged = new Uint8Array(encoded.reduce((size, bytes) => size + bytes.length, 0));
  let start = 0; for (const bytes of encoded) { merged.set(bytes, start); start += bytes.length; }
  const input = options.merged === true ? [merged] : encoded; let offset = 0, writes = 0, reads = 0;
  const failures: unknown[] = [], exceptions: unknown[] = [], signals: number[] = [], trace: NativeFrame[] = [], transport: { operation: string; bytes: number; milliseconds: number }[] = []; let polls = 0;
  let deliverException: (() => void) | undefined;
  const bridge = new NativeBridge({ call: (operation, signal) => {
    if (!poll) throw new Error("No asynchronous request expected");
    if (options.waitForAbort === true && polls++ === 0) return new Promise((_resolve, reject) => {
      if (signal === undefined) return;
      signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
    });
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    view.setInt32(0, 3, true); view.setUint16(4, 1, true); view.setUint16(6, 1, true);
    return polls++ === 0 ? Promise.resolve(operation.decode({ value: 1n, bytes })) : new Promise(() => undefined);
  } }, {
    read(_fd, count) {
      reads++;
      const bytes = input[0]; if (bytes === undefined) throw new Error("Unexpected native read");
      const result = bytes.slice(offset, offset + readMin(count, options.readSize ?? 3)); offset += result.length;
      if (offset === bytes.length) { input.shift(); offset = 0; } return result;
    },
    writeAll() { writes++; },
  }, 3, 4, { ...(options.runtime === undefined ? {} : { runtime: options.runtime }), changed: () => undefined, failed: error => { failures.push(error); }, uncaught: (error, around) => {
    const delivery = () => { around(() => { exceptions.push(error); uncaught?.(error); }); };
    if (deferException) deliverException = delivery; else delivery();
  }, signal: signal => { signals.push(signal); }, trace: frame => { trace[trace.length] = frame; }, transport: event => { transport[transport.length] = event; } });
  return { bridge, failures, exceptions, signals, trace, transport, reads: () => reads, writes: () => writes, deliverException: () => { if (deliverException === undefined) throw new Error("No queued exception"); deliverException(); } };
}
const completion: NativeFrame = { kind: 2, sequence: 1, scope: 1n, environment: 0n, operation: "load", status: 0, args: [0n], bytes: new Uint8Array() };

for (const key of ["Number", "BigInt", "DataView", "Uint8Array", "set", "subarray", "slice"] as const) for (const throwing of [false, true]) it("native transport ignores " + key + " allocation getters throwing=" + String(throwing), () => {
  const prototype = Reflect.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null) throw new Error("Missing transport byte prototype");
  const owner = key === "set" || key === "subarray" || key === "slice" ? prototype : globalThis;
  const original = Object.getOwnPropertyDescriptor(owner, key), define = Object.defineProperty;
  if (original === undefined) throw new Error("Missing transport allocation intrinsic");
  const previous: unknown = original.value, bytes = encodeNativeFrame(completion), trace: NativeFrame[] = [];
  let reads = 0;
  const bridge = new NativeBridge({ call: () => { throw new Error("Unexpected asynchronous transport"); } }, {
    read: () => { if (reads++ !== 0) throw new Error("Unexpected native read"); return bytes; }, writeAll: () => undefined,
  }, 3, 4, { changed: () => undefined, failed: error => { throw error; }, uncaught: error => { throw error; }, trace: frame => { trace[trace.length] = frame; } });
  let effects = 0, failure: unknown, output: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application transport allocator"); return previous; } });
    try { output = bridge.load("/fixture.node"); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(output).toBeUndefined();
  expect(trace).toHaveLength(2); expect(bridge.pending).toBe(0);
});

for (const key of ["min", "max", "isSafeInteger", "getUint32", "setUint32", "getBigUint64", "setBigUint64", "push"] as const) for (const throwing of [false, true]) it("native prefix reads ignore " + key + " getters throwing=" + String(throwing), () => {
  const owner = key === "min" || key === "max" ? Math : key === "isSafeInteger" ? Number : key === "push" ? Array.prototype : DataView.prototype;
  const define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(owner, key);
  if (original === undefined) throw new Error("Missing native prefix intrinsic");
  const previous: unknown = original.value, test = fixture([completion], false, undefined, false, { merged: true, readSize: 65536 });
  let effects = 0, failure: unknown, result: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application prefix primitive"); return previous; } });
    try { result = test.bridge.load("/fixture.node"); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(result).toBeUndefined(); expect(test.failures).toEqual([]);
  expect(test.bridge.pending).toBe(0); expect(test.trace).toHaveLength(2);
});

for (const poison of ["encoder-constructor", "decoder-constructor", "encode", "decode"] as const) for (const throwing of [false, true]) it("native registration ignores " + poison + " getters throwing=" + String(throwing), () => {
  const Encoder = TextEncoder, Decoder = TextDecoder, define = Object.defineProperty;
  const owner = poison === "encode" ? Encoder.prototype : poison === "decode" ? Decoder.prototype : globalThis;
  const key = poison === "encoder-constructor" ? "TextEncoder" : poison === "decoder-constructor" ? "TextDecoder" : poison;
  const original = Object.getOwnPropertyDescriptor(owner, key);
  if (original === undefined) throw new Error("Missing encoding intrinsic descriptor");
  const previousValue: unknown = original.value;
  const registration: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 1n, operation: "register-environment", status: 0, args: [8n], bytes: new Encoder().encode("/fixture.node") };
  const test = fixture([registration, completion]);
  let effects = 0, failure: unknown, result: unknown;
  try {
    define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application encoding getter"); return previousValue; } });
    try { result = test.bridge.load("/fixture.node"); } catch (error) { failure = error; }
  } finally { define(owner, key, original); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(result).toBeUndefined();
  expect(test.failures).toEqual([]);
  expect(test.trace.find(frame => frame.kind === 4 && frame.operation === "register-environment")?.args).toEqual([0n, 0n]);
  expect(test.bridge.pending).toBe(0);
});

for (const runtime of ["node", "bun"] as const) it(`binds ${runtime} to the native environment registration acknowledgement`, () => {
  const registration: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 1n, operation: "register-environment", status: 0, args: [8n], bytes: new TextEncoder().encode("/fixture.node") };
  const test = fixture([registration, completion], false, undefined, false, { runtime });
  test.bridge.load("/fixture.node");
  expect(test.trace.find(frame => frame.kind === 4 && frame.operation === "register-environment")?.args).toEqual([0n, runtime === "bun" ? 1n : 0n]);
  expect(test.failures).toEqual([]);
});

for (const readSize of [3, 65536]) it(`ignores application Math.min during native reads of ${readSize} bytes`, () => {
  const test = fixture([completion], false, undefined, false, { readSize });
  const define = Object.defineProperty, previous = Object.getOwnPropertyDescriptor(Math, "min");
  if (previous === undefined) throw new Error("Missing Math.min descriptor");
  let effects = 0, failure: unknown, result: unknown;
  try {
    define(Math, "min", { configurable: true, get() { effects++; throw new Error("Application Math.min"); } });
    try { result = test.bridge.load("/addon.node"); } catch (error) { failure = error; }
  } finally { define(Math, "min", previous); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(result).toBeUndefined();
  expect(test.failures).toEqual([]); expect(test.trace).toHaveLength(2);
});

it("retains an outer completion while its asynchronous callback re-enters the native host", () => {
  const asyncScope = 0x1_0000_0001n;
  const test = fixture([
    { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_object", status: 0, args: [], bytes: new Uint8Array() },
    { kind: 6, sequence: 1, scope: asyncScope, environment: 0n, operation: "async-queued", status: 0, args: [1n], bytes: new Uint8Array() },
    { kind: 3, sequence: 2, scope: asyncScope, environment: 0n, operation: "napi_call_function", status: 0, args: [2n, 1n], bytes: new Uint8Array() },
    { ...completion, args: [4n] },
    { ...completion, sequence: 2, scope: 2n },
    { kind: 5, sequence: 1, scope: asyncScope, environment: 0n, operation: "async-complete", status: 0, args: [1n], bytes: new Uint8Array() },
    { ...completion, sequence: 3, scope: 3n },
  ]);
  let callbackCalls = 0;
  test.bridge.values.add(() => {
    callbackCalls++;
    expect(test.bridge.load("/nested.node")).toBeUndefined();
    expect(test.bridge.values.get(4n)).toEqual({});
  });
  test.bridge.values.add({});
  expect(test.bridge.load("/outer.node")).toEqual({});
  expect(callbackCalls).toBe(1);
  expect(() => test.bridge.values.get(4n)).toThrow(/stale/u);
  expect(test.bridge.load("/after.node")).toBeUndefined();
  expect(test.bridge.pending).toBe(0); expect(test.failures).toEqual([]);
  expect(test.trace.filter(frame => frame.kind === 2).map(frame => frame.sequence)).toEqual([1, 2, 3]);
});

it("rejects foreign identities and malformed invocation completions", () => {
  const invalid: readonly Partial<NativeFrame>[] = [
    { sequence: 2, scope: 2n }, { operation: "call" },
    { status: 1 }, { args: [] }, { args: [0n, 0n] }, { bytes: new Uint8Array([1]) },
  ];
  for (const patch of invalid) {
    const test = fixture([{ ...completion, ...patch }]);
    expect(() => test.bridge.load("/fixture.node")).toThrow(/Stale native invocation completion/u);
    expect(test.failures).toHaveLength(1); expect(test.writes()).toBe(1);
  }
});

it("rejects a duplicate outer completion before delivering it to a nested call", () => {
  const request: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_call_function", status: 0, args: [2n, 1n], bytes: new Uint8Array() };
  const test = fixture([request, completion, completion]);
  test.bridge.values.add(() => { test.bridge.load("/nested.node"); });
  test.bridge.values.add({});
  expect(() => test.bridge.load("/outer.node")).toThrow(/Stale native invocation completion/u);
  expect(test.trace.filter(frame => frame.kind === 2)).toHaveLength(2);
});

it("bounds synchronous re-entry before sending an invocation that exceeds the native stack", () => {
  for (const depth of [64, 65]) {
    const frames: NativeFrame[] = [
      ...Array.from({ length: depth - 1 }, (_, index) => ({ kind: 3, sequence: index + 1, scope: BigInt(index + 1), environment: 0n, operation: "napi_call_function", status: 0, args: [2n, 1n], bytes: new Uint8Array() })),
      ...Array.from({ length: depth }, (_, index) => ({ ...completion, sequence: depth - index, scope: BigInt(depth - index) })),
    ];
    const test = fixture(frames);
    test.bridge.values.add(() => test.bridge.load("/nested.node")); test.bridge.values.add({});
    if (depth === 64) {
      expect(test.bridge.load("/outer.node")).toBeUndefined(); expect(test.failures).toEqual([]);
    } else {
      expect(() => test.bridge.load("/outer.node")).toThrow(/Native invocation depth bound/u);
      expect(() => test.bridge.load("/after.node")).toThrow(/Native invocation depth bound/u);
    }
    expect(test.trace.filter(frame => frame.kind === 1)).toHaveLength(64);
  }
});

it("acknowledges native retirement after finalization and disposes only once", () => {
  const test = fixture([
    { ...completion, operation: "cleanup" },
    { ...completion, sequence: 2, scope: 2n, operation: "finalize-environments" },
    { ...completion, sequence: 3, scope: 3n, operation: "retire-environment" },
  ]);
  test.bridge.dispose(); test.bridge.dispose();
  expect(test.trace.filter(frame => frame.kind === 1).map(frame => frame.operation)).toEqual(["cleanup", "finalize-environments", "retire-environment"]);
  expect(test.writes()).toBe(3); expect(test.bridge.pending).toBe(0);
  expect(() => test.bridge.load("/fixture.node")).toThrow(/retired/u);
  expect(test.failures).toEqual([]);
});

it("keeps the application exit status separate from Node-API completion status", () => {
  const test = fixture([
    { ...completion, operation: "cleanup" },
    { ...completion, sequence: 2, scope: 2n, operation: "finalize-environments" },
    { ...completion, sequence: 3, scope: 3n, operation: "retire-environment" },
  ]);
  test.bridge.dispose(23);
  expect(test.trace.find(frame => frame.kind === 1 && frame.operation === "retire-environment")).toMatchObject({ status: 0, args: [23n] });
  expect(test.failures).toEqual([]);
});

it("rejects invalid application exit statuses before native cleanup", () => {
  for (const code of [-1, 256, 1.5, NaN]) {
    const test = fixture([]);
    expect(() => test.bridge.dispose(code)).toThrow(); expect(test.writes()).toBe(0);
  }
});

it("preserves a pending application exception across internal callback ownership messages", () => {
  const add: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_add_finalizer", status: 0, args: [1n, 4103n, 1n], bytes: new Uint8Array() };
  const test = fixture([
    add, { ...completion, operation: "claim-callback", sequence: 2, scope: 2n },
    { ...add, sequence: 2, operation: "napi_delete_reference", args: [4096n] },
    { ...completion, operation: "retire-callback", sequence: 3, scope: 3n }, completion,
  ]);
  test.bridge.values.add({}); const error = new Error("pending application error");
  test.bridge.values.dispatch("napi_throw", [test.bridge.values.add(error)], new Uint8Array());
  expect(() => test.bridge.load("/fixture.node")).toThrow(error);
  expect(test.failures).toEqual([]);
  expect(test.trace.filter(frame => frame.kind === 4).map(frame => [frame.operation, frame.status])).toEqual([["napi_add_finalizer", 0], ["napi_delete_reference", 0]]);
});

it("binds each module registration to its active load before accepting operations", () => {
  const registration: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 1n, operation: "register-environment", status: 0, args: [10n], bytes: new TextEncoder().encode("/fixture.node") };
  const request: NativeFrame = { ...registration, sequence: 2, operation: "napi_get_undefined", args: [], bytes: new Uint8Array() };
  const valid = fixture([registration, request, completion]);
  valid.bridge.load("/fixture.node"); expect(valid.failures).toEqual([]);
  expect(valid.trace.filter(frame => frame.kind === 4).map(frame => frame.environment)).toEqual([1n, 1n]);
  for (const patch of [{ environment: 0n }, { environment: 0x1_0000_0001n }, { args: [11n] }, { bytes: new TextEncoder().encode("/different.node") }]) {
    const invalid = fixture([{ ...registration, ...patch }, completion]);
    expect(() => invalid.bridge.load("/fixture.node")).toThrow(/registration/u);
    expect(invalid.writes()).toBe(1);
  }
  const unknown = fixture([{ ...request, sequence: 1 }, completion]);
  expect(() => unknown.bridge.load("/fixture.node")).toThrow(/environment/u);
  expect(unknown.writes()).toBe(1);
});

it("reads a small frame in one crossing and preserves consecutive buffered frames", () => {
  const test = fixture([completion, { ...completion, sequence: 2, scope: 2n }], false, undefined, false, { readSize: 65536, merged: true });
  test.bridge.load("/fixture.node");
  test.bridge.load("/fixture.node");
  expect(test.reads()).toBe(1);
  expect(test.transport.map(event => event.operation)).toEqual(["write", "read", "write"]);
  expect(test.transport.find(event => event.operation === "read")?.bytes).toBe(encodeNativeFrame(completion).length * 2);
  expect(test.transport.every(event => event.milliseconds >= 0)).toBe(true);
  expect(test.failures).toEqual([]);
});

it("retires a stale readiness wait and services a prefetched async frame without another wake", async () => {
  const reference: NativeFrame = { kind: 7, sequence: 5, scope: 0x1_0000_0005n, environment: 0n, operation: "async-reference", status: 0, args: [5n, 1n], bytes: new Uint8Array() };
  const test = fixture([completion, reference], true, undefined, false, { readSize: 65536, merged: true, waitForAbort: true });
  test.bridge.watch();
  test.bridge.load("/fixture.node");
  for (let index = 0; index < 6; index++) await Promise.resolve();
  expect(test.bridge.pending).toBe(1);
  expect(test.reads()).toBe(1);
  expect(test.failures).toEqual([]);
});

it("traces actual invocation and result frames with their original scope identity", () => {
  const test = fixture([completion]); test.bridge.load("/fixture.node");
  expect(test.trace.map(frame => [frame.kind, frame.sequence, frame.scope, frame.operation])).toEqual([[1, 1, 1n, "load"], [2, 1, 1n, "load"]]);
  expect(test.writes()).toBe(1);
});

it("traces a Node-API reply only after its control write completes", () => {
  const request: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_get_undefined", status: 0, args: [], bytes: new Uint8Array() };
  const test = fixture([request, completion]);
  test.bridge.load("/fixture.node");
  expect(test.trace.map(frame => [frame.kind, frame.sequence, frame.operation])).toEqual([
    [1, 1, "load"], [3, 1, "napi_get_undefined"], [4, 1, "napi_get_undefined"], [2, 1, "load"],
  ]);
  expect(test.writes()).toBe(2);
});

it("delivers native Linux signals once without treating them as Node-API callbacks", () => {
  const signal = { kind: 8, sequence: 1, scope: 0x1_0000_0001n, environment: 0n, operation: "signal", status: 0, args: [2n], bytes: new Uint8Array() };
  const test = fixture([signal, completion, signal, { ...completion, sequence: 2, scope: 2n }]);
  test.bridge.load("/fixture.node"); expect(test.signals).toEqual([2]);
  expect(() => test.bridge.load("/fixture.node")).toThrow(/signal/u);
  expect(test.failures).toHaveLength(1);
});

it("handles short control reads and retires a stale completion without replay", () => {
  const test = fixture([{ ...completion, sequence: 2, scope: 2n }]);
  expect(() => test.bridge.load("/fixture.node")).toThrow(/Stale/u);
  expect(test.failures).toHaveLength(1);
  expect(() => test.bridge.load("/fixture.node")).toThrow(/Stale/u);
  expect(test.writes()).toBe(1);
});

it("keeps a native application exception separate from transport failure", () => {
  const test = fixture([completion, { ...completion, sequence: 2, scope: 2n }]), error = new Error("application");
  test.bridge.values.dispatch("napi_throw", [test.bridge.values.add(error)], new Uint8Array());
  expect(() => test.bridge.load("/fixture.node")).toThrow(error);
  expect(test.bridge.load("/fixture.node")).toBeUndefined();
  expect(test.failures).toEqual([]); expect(test.writes()).toBe(2);
});

it("delivers a fatal exception through the process exception owner without leaving a pending value", () => {
  const fatal: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_fatal_exception", status: 0, args: [1n], bytes: new Uint8Array() };
  const test = fixture([fatal, completion]), error = new Error("fatal native callback");
  test.bridge.values.add(error);
  expect(() => test.bridge.load("/fixture.node")).not.toThrow();
  expect(test.exceptions).toEqual([error]); expect(test.failures).toEqual([]);
  expect(test.bridge.values.dispatch("napi_is_exception_pending", [], new Uint8Array()).args).toEqual([0n]);
  expect(test.trace.find(frame => frame.kind === 4)?.status).toBe(0);
});

it("delivers async completion exceptions before idle and clears them before another call", async () => {
  const scope = 0x1_0000_0001n;
  const error = new Error("async completion error");
  const test = fixture([
    { kind: 6, sequence: 1, scope, environment: 0n, operation: "async-queued", status: 0, args: [1n], bytes: new Uint8Array() }, completion,
    { kind: 3, sequence: 1, scope, environment: 0n, operation: "napi_throw", status: 0, args: [1n], bytes: new Uint8Array() },
    { kind: 5, sequence: 1, scope, environment: 0n, operation: "async-complete", status: 0, args: [1n], bytes: new Uint8Array() },
    { ...completion, sequence: 2, scope: 2n },
  ], true, caught => { expect(caught).toBe(error); expect(() => test.bridge.load("/fixture.node")).toThrow(error); });
  test.bridge.values.add(error);
  test.bridge.load("/fixture.node"); test.bridge.watch();
  await new Promise(done => setTimeout(done, 0));
  expect(test.exceptions).toEqual([error]); expect(test.failures).toEqual([]);
  expect(test.bridge.pending).toBe(0);
  expect(test.bridge.load("/fixture.node")).toBeUndefined();
});

it("references thread-safe functions independently from queued native callbacks", () => {
  const reference = { kind: 7, sequence: 5, scope: 0x1_0000_0005n, environment: 0n, operation: "async-reference", status: 0, args: [5n, 1n], bytes: new Uint8Array() };
  const test = fixture([reference, completion, { ...reference, args: [5n, 0n] }, { ...completion, sequence: 2, scope: 2n }, { ...reference, args: [5n, 1n] }, { ...completion, sequence: 3, scope: 3n }, { ...reference, args: [5n, 2n] }, { ...completion, sequence: 4, scope: 4n }]);
  test.bridge.load("/fixture.node"); expect(test.bridge.pending).toBe(1);
  test.bridge.load("/fixture.node"); expect(test.bridge.pending).toBe(0);
  test.bridge.load("/fixture.node"); expect(test.bridge.pending).toBe(1);
  test.bridge.load("/fixture.node"); expect(test.bridge.pending).toBe(0);
  expect(test.failures).toEqual([]);
});

it("keeps exception re-entry rules while delivery waits in the process scheduler", async () => {
  const scope = 0x1_0000_0001n, error = new Error("scheduled native error");
  const test = fixture([
    { kind: 6, sequence: 1, scope, environment: 0n, operation: "async-queued", status: 0, args: [1n], bytes: new Uint8Array() }, completion,
    { kind: 3, sequence: 1, scope, environment: 0n, operation: "napi_throw", status: 0, args: [1n], bytes: new Uint8Array() },
    { kind: 5, sequence: 1, scope, environment: 0n, operation: "async-complete", status: 0, args: [1n], bytes: new Uint8Array() },
    { ...completion, sequence: 2, scope: 2n, environment: 0n, operation: "cleanup" },
    { ...completion, sequence: 3, scope: 3n, environment: 0n, operation: "finalize-environments" },
    { ...completion, sequence: 4, scope: 4n, environment: 0n, operation: "retire-environment" },
  ], true, caught => {
    expect(caught).toBe(error); expect(() => test.bridge.load("/fixture.node")).toThrow(error);
    test.bridge.dispose();
  }, true);
  test.bridge.values.add(error); test.bridge.load("/fixture.node"); test.bridge.watch();
  await new Promise(done => setTimeout(done, 0));
  test.deliverException();
  expect(() => test.bridge.load("/fixture.node")).toThrow(/retired/u); expect(test.failures).toEqual([]);
});
