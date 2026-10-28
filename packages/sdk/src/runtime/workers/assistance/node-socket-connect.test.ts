import { afterAll, expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessIO } from "./process-io.js";

vi.hoisted(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterAll(() => { vi.useRealTimers(); });
const addresses = [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
const connected = { kind: "socket", fd: 8, local: { address: "127.0.0.1", port: 4321 }, peer: { address: "127.0.0.1", port: 8080 } } as const;
const refused = { kind: "error", errno: 111, code: "ECONNREFUSED", syscall: "socket-connect-local", path: null, destination: null } as const;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(call: ProcessIO["call"]) {
  let references = 0;
  const net = createNodeSockets({ call, callSync: () => connected, retain: () => { references++; return () => { references--; }; } }, createAsyncContext());
  return { net, references: () => references };
}
const lookup = (_host: unknown, _options: unknown, cb: unknown) => {
  if (typeof cb !== "function") throw new Error("No lookup callback");
  Reflect.apply(cb, undefined, [null, addresses]);
};

it("uses lookup family order, retries refusal, and retains only the winning Rust socket", async () => {
  const calls: string[] = [], lookupCalls: unknown[][] = [];
  const { net, references } = fixture(async operation => {
    await Promise.resolve();
    if (operation.kind === "socket-connect-local") { calls.push(operation.address.address); return operation.address.address === "::1" ? refused : connected; }
    if (operation.kind === "socket-read") return { kind: "data", bytes: new Uint8Array() };
    return { kind: "unit" };
  });
  const events: unknown[][] = [];
  const socket = net.connect({ host: "native-parity.invalid", port: 8080, lookup: (...args: unknown[]) => { lookupCalls.push(args.slice(0, 2)); Reflect.apply(lookup, undefined, args); } });
  for (const name of ["connectionAttempt", "connectionAttemptFailed", "connect", "ready", "error"]) socket.on(name, (...args: unknown[]) => { events.push([name, ...args]); });
  await tick();
  expect(lookupCalls).toEqual([["native-parity.invalid", { hints: 32, all: true }]]);
  expect(calls).toEqual(["::1", "127.0.0.1"]);
  expect(events.map(event => event[0])).toEqual(["connectionAttemptFailed", "connectionAttempt", "connect", "ready"]);
  expect(events[0]?.slice(1, 4)).toEqual(["::1", 8080, 6]);
  expect(events[0]?.[4]).toMatchObject({ code: "ECONNREFUSED", message: "connect ECONNREFUSED ::1:8080" });
  expect(socket.autoSelectFamilyAttemptedAddresses).toEqual(["::1:8080", "127.0.0.1:8080"]);
  expect(socket.remoteFamily).toBe("IPv4");
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await vi.runOnlyPendingTimersAsync(); await closed;
  expect(references()).toBe(0);
});

it.each([false, true])("applies the configured attempt deadline and cancels before trying another address (override=%s)", async override => {
  const operations: string[] = [], events: string[] = [], read = Promise.withResolvers<AssistanceResult>();
  const { net, references } = fixture((operation, _referenced, signal) => {
    if (operation.kind === "socket-connect-local") {
      operations.push(operation.address.address);
      if (operation.address.address === "::1") return new Promise<AssistanceResult>(resolve => {
        signal?.addEventListener("abort", () => { operations.push("cancelled"); resolve({ ...refused, errno: 125, code: "ECANCELED" }); }, { once: true });
      });
      return Promise.resolve(connected);
    }
    if (operation.kind === "socket-read") return read.promise;
    if (operation.kind === "socket-close") read.resolve({ kind: "data", bytes: new Uint8Array() });
    return Promise.resolve({ kind: "unit" });
  });
  net.setDefaultAutoSelectFamilyAttemptTimeout(override ? 30000 : 17);
  const socket = new net.Socket();
  socket.on("error", error => { throw error; });
  socket.on("connectionAttemptTimeout", () => { events.push("timeout"); });
  socket.connect({ host: "test.invalid", port: 8080, lookup, ...(override ? { autoSelectFamilyAttemptTimeout: 17 } : {}) });
  await tick(); await vi.advanceTimersByTimeAsync(16);
  expect(operations).toEqual(["::1"]);
  await vi.advanceTimersByTimeAsync(1); await tick();
  expect(operations).toEqual(["::1", "cancelled", "127.0.0.1"]); expect(events).toEqual(["timeout"]);
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await vi.runOnlyPendingTimersAsync(); await closed;
  expect(references()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("uses the current family default for lookup and never races when selection is disabled", async () => {
  const calls: unknown[] = [];
  const { net } = fixture(async operation => {
    await Promise.resolve();
    if (operation.kind === "socket-connect-local") { calls.push(operation.address); return connected; }
    return operation.kind === "socket-read" ? { kind: "data", bytes: new Uint8Array() } : { kind: "unit" };
  });
  net.setDefaultAutoSelectFamily(false);
  const socket = net.connect({ host: "test.invalid", port: 8080, lookup(host: unknown, options: unknown, cb: unknown) {
    calls.push([host, options]); if (typeof cb !== "function") throw new Error("No callback"); Reflect.apply(cb, undefined, [null, "127.0.0.1", 4]);
  } });
  socket.on("error", error => { throw error; }); await tick();
  expect(calls).toEqual([["test.invalid", { family: 0, hints: 32 }], { address: "127.0.0.1", port: 8080 }]);
  expect(socket.autoSelectFamilyAttemptedAddresses).toBeUndefined();
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await closed;
});

it("rejects malformed lookup results before Linux allocation and closes on all-address failure", async () => {
  const calls: string[] = [], failures: unknown[] = [];
  const { net, references } = fixture(async operation => {
    await Promise.resolve(); calls.push(operation.kind); return refused; });
  const bad = net.connect({ host: "bad.invalid", port: 8080, lookup(_host: unknown, _options: unknown, cb: unknown) {
    if (typeof cb !== "function") throw new Error("No callback"); Reflect.apply(cb, undefined, [null, [{ address: "../escape", family: 4 }]]);
  } });
  bad.on("error", error => { failures.push(error); });
  const badClosed = new Promise(resolve => bad.once("close", resolve)); await tick(); await badClosed;
  expect(calls).toEqual([]); expect(failures).toHaveLength(1); expect(references()).toBe(0);
  const socket = net.connect({ host: "closed.invalid", port: 8080, lookup });
  socket.on("error", error => { failures.push(error); });
  const closed = new Promise(resolve => socket.once("close", resolve)); await tick(); await closed;
  expect(failures[1]).toMatchObject({ name: "AggregateError", code: "ECONNREFUSED", errors: [{ address: "::1" }, { address: "127.0.0.1" }] });
  expect(calls).toEqual(["socket-connect-local", "socket-connect-local"]); expect(references()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("cancels during lookup without allocating a socket or accepting a late duplicate callback", async () => {
  const calls = vi.fn<ProcessIO["call"]>(() => Promise.resolve({ kind: "unit" }));
  const { net, references } = fixture(calls);
  let reply: unknown;
  const socket = net.connect({ host: "slow.invalid", port: 8080, lookup(_host: unknown, _options: unknown, callback: unknown) { reply = callback; } });
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await tick(); await closed;
  if (typeof reply !== "function") throw new Error("Missing lookup callback");
  Reflect.apply(reply, undefined, [null, addresses]); Reflect.apply(reply, undefined, [null, addresses]);
  await tick(); expect(calls).not.toHaveBeenCalled(); expect(references()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("does not time out the last address and cancels it when the socket is destroyed", async () => {
  const aborted: string[] = [];
  const { net, references } = fixture((operation, _referenced, signal) => {
    if (operation.kind !== "socket-connect-local") throw new Error("Unexpected socket operation");
    if (operation.address.address === "::1") return Promise.resolve(refused);
    return new Promise(resolve => {
      signal?.addEventListener("abort", () => { aborted.push(operation.address.address); resolve({ ...refused, errno: 125, code: "ECANCELED" }); }, { once: true });
    });
  });
  net.setDefaultAutoSelectFamilyAttemptTimeout(10);
  const socket = net.connect({ host: "last.invalid", port: 8080, lookup });
  socket.on("error", error => { throw error; }); await tick();
  await vi.advanceTimersByTimeAsync(1000); expect(aborted).toEqual([]); expect(socket.connecting).toBe(true);
  const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy(); await tick(); await closed;
  expect(aborted).toEqual(["127.0.0.1"]); expect(references()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("deduplicates answers, alternates from the first family, and preserves a single-address error", async () => {
  const tried: string[] = [], failures: unknown[] = [];
  const { net, references } = fixture(operation => {
    if (operation.kind !== "socket-connect-local") throw new Error("Unexpected socket operation");
    tried.push(operation.address.address); return Promise.resolve(refused);
  });
  const connect = async (values: object[]) => {
    const socket = net.connect({ host: "all.invalid", port: 8080, lookup(_host: unknown, _options: unknown, cb: unknown) {
      if (typeof cb !== "function") throw new Error("Missing lookup callback"); Reflect.apply(cb, undefined, [null, values]);
    } });
    socket.on("error", error => { failures.push(error); });
    const closed = new Promise(resolve => socket.once("close", resolve)); await tick(); await closed;
  };
  await connect([{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }, { address: "::1", family: 6 }, { address: "::2", family: 6 }, { address: "127.0.0.1", family: 4 }]);
  expect(tried).toEqual(["127.0.0.1", "::1", "127.0.0.2", "::2"]);
  expect(failures[0]).toMatchObject({ name: "AggregateError" });
  await connect([{ address: "127.0.0.1", family: 4 }]);
  expect(failures[1]).toMatchObject({ name: "Error", code: "ECONNREFUSED" }); expect(references()).toBe(0);
});
