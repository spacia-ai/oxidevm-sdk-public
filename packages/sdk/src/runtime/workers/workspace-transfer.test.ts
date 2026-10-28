import { expect, it } from "vitest";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { transferWorkspaceStream, receiveWorkspaceStream } from "./workspace-transfer.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };

it("retains stream credit after EOF until independent retirement is acknowledged", async () => {
  const traffic = new AssistanceTraffic(6);
  const retired = Promise.withResolvers<undefined>();
  let retirementCalls = 0;
  const sending = transferWorkspaceStream({ bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([7])); })(),
    retire: () => { retirementCalls += 1; return retired.promise; },
  }) }, binding, 1, traffic);
  const descriptor: unknown = structuredClone(sending.descriptor, { transfer: sending.transfer });
  const producer = receiveWorkspaceStream(descriptor, binding, 1).source(new AbortController().signal);
  const iterator = producer.frames[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(new Uint8Array([7]));
  expect((await iterator.next()).done).toBe(true);
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  const stopping = producer.retire();
  await Promise.resolve();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  retired.resolve(undefined);
  await stopping;
  await sending.finished;
  expect(retirementCalls).toBe(1);
  expect(traffic.pendingBytes).toBe(0);
});

it("cancels a pending source read and still waits for native retirement", async () => {
  const traffic = new AssistanceTraffic(6);
  const entered = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  const sending = transferWorkspaceStream({ bytes: 1, source: signal => ({
    frames: (async function* () {
      await new Promise<undefined>(resolve => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
        entered.resolve(undefined);
      });
      if (!signal.aborted) yield new Uint8Array([1]);
    })(),
    retire: () => retired.promise,
  }) }, binding, 2, traffic);
  const descriptor: unknown = structuredClone(sending.descriptor, { transfer: sending.transfer });
  const controller = new AbortController();
  const producer = receiveWorkspaceStream(descriptor, binding, 2).source(controller.signal);
  const reading = producer.frames[Symbol.asyncIterator]().next();
  await entered.promise;
  controller.abort();
  const stopping = producer.retire();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  retired.resolve(undefined);
  await stopping;
  await reading;
  await sending.finished;
  expect(traffic.pendingBytes).toBe(0);
});

it("retirements remain observable after a rejected data read", async () => {
  const traffic = new AssistanceTraffic(6);
  let retired = false;
  const sending = transferWorkspaceStream({ bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.reject(new Error("native read failed")); })(),
    retire: () => { retired = true; return Promise.resolve(); },
  }) }, binding, 3, traffic);
  const descriptor: unknown = structuredClone(sending.descriptor, { transfer: sending.transfer });
  const producer = receiveWorkspaceStream(descriptor, binding, 3).source(new AbortController().signal);
  await expect(producer.frames[Symbol.asyncIterator]().next()).rejects.toThrow("native read failed");
  await producer.retire();
  await sending.finished;
  expect(retired).toBe(true);
  expect(traffic.pendingBytes).toBe(0);
});

it("rejects stale bindings and oversized frames without forgiving retirement", async () => {
  const traffic = new AssistanceTraffic(6);
  const sending = transferWorkspaceStream({ bytes: 65537, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array(65537)); })(),
    retire: () => Promise.resolve(),
  }) }, binding, 4, traffic);
  const descriptor: unknown = structuredClone(sending.descriptor, { transfer: sending.transfer });
  expect(() => receiveWorkspaceStream(descriptor, { ...binding, generation: 2 }, 4)).toThrow("transfer");
  expect(() => receiveWorkspaceStream(descriptor, binding, 5)).toThrow("transfer");
  const producer = receiveWorkspaceStream(descriptor, binding, 4).source(new AbortController().signal);
  await expect(producer.frames[Symbol.asyncIterator]().next()).rejects.toThrow("transfer");
  await producer.retire();
  await sending.finished;
  expect(traffic.pendingBytes).toBe(0);
});

it("keeps credit fenced if independent native retirement fails", async () => {
  const traffic = new AssistanceTraffic(6);
  const sending = transferWorkspaceStream({ bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([7])); })(),
    retire: () => Promise.reject(new Error("native owner lost")),
  }) }, binding, 5, traffic);
  const descriptor: unknown = structuredClone(sending.descriptor, { transfer: sending.transfer });
  const producer = receiveWorkspaceStream(descriptor, binding, 5).source(new AbortController().signal);
  const iterator = producer.frames[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await expect(producer.retire()).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true } });
  await expect(sending.finished).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true } });
  expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("retires an attached native producer even when cancelled before the first read", async () => {
  const traffic = new AssistanceTraffic(6);
  let calls = 0;
  const sending = transferWorkspaceStream({ bytes: 1, source: () => ({
    frames: (async function* () { yield await Promise.resolve(new Uint8Array([7])); })(),
    retire: () => { calls += 1; return Promise.resolve(); },
  }) }, binding, 6, traffic);
  const producer = receiveWorkspaceStream(sending.descriptor, binding, 6).source(new AbortController().signal);
  await producer.retire();
  await sending.finished;
  expect(calls).toBe(1);
  expect(traffic.pendingBytes).toBe(0);
});
