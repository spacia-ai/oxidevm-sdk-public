import { afterEach, expect, it, vi } from "vitest";

import { AttentionReceipts } from "../host-attention.js";
import {
  ATTENTION_NOTICES_VERSION,
  AttentionNotices,
  decodeAttentionNoticesRequest,
  serveAttentionNotices,
  type AttentionNoticesWorker,
} from "./attention-notices.js";

const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); });

function counter(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

/** The notices worker in this thread, reached through structured clones like a real worker. */
function localNoticesWorker() {
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };
  serveAttentionNotices(scope);
  const listeners: (() => void)[] = [];
  const worker: AttentionNoticesWorker & { fail(): void; terminated: boolean } = {
    terminated: false,
    postMessage(message, transfer) { scope.onmessage?.(new MessageEvent("message", { data: structuredClone(message, { transfer }) })); },
    terminate() { this.terminated = true; },
    addEventListener(_type, listener) { listeners.push(listener); },
    fail() { for (const listener of listeners) listener(); },
  };
  return worker;
}

it("decodes watch and release requests and rejects stale or malformed ones", () => {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  const watch = { version: ATTENTION_NOTICES_VERSION, type: "watch", id: 3, port: channel.port1, counter: counter() };
  expect(decodeAttentionNoticesRequest(watch)).toMatchObject({ type: "watch", id: 3 });
  expect(decodeAttentionNoticesRequest({ version: ATTENTION_NOTICES_VERSION, type: "release", id: 3 })).toEqual({ type: "release", id: 3 });
  expect(() => decodeAttentionNoticesRequest({ ...watch, version: ATTENTION_NOTICES_VERSION + 1 })).toThrow(/version mismatch/u);
  expect(() => decodeAttentionNoticesRequest({ ...watch, counter: null })).toThrow(/Invalid attention notices watch/u);
  expect(() => decodeAttentionNoticesRequest({ ...watch, id: 0 })).toThrow(/attention notices ID/u);
  expect(() => decodeAttentionNoticesRequest({ ...watch, extra: true })).toThrow(/unexpected protocol field extra/u);
});

it("counts each notice a cross-origin producer sends, and none after release", async () => {
  const notices = new AttentionNotices(localNoticesWorker), shared = counter(), receipts = new AttentionReceipts(shared);
  const channel = notices.open(shared);
  if (channel === undefined) throw new Error("Notices are unavailable");
  ports.push(channel.port);
  channel.port.postMessage(null);
  channel.port.postMessage(null);
  await vi.waitFor(() => expect(Atomics.load(shared, 0)).toBe(2));
  expect(receipts.pending()).toBe(true);
  receipts.delivered(); receipts.delivered();
  expect(receipts.pending()).toBe(false);
  channel.release();
  channel.release();
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  expect(Atomics.load(shared, 0)).toBe(2);
});

it("starts one notices worker for all channels and terminates it on disposal", () => {
  const started: ReturnType<typeof localNoticesWorker>[] = [];
  const notices = new AttentionNotices(() => { const worker = localNoticesWorker(); started.push(worker); return worker; });
  const first = notices.open(counter()), second = notices.open(counter());
  if (first !== undefined) ports.push(first.port);
  if (second !== undefined) ports.push(second.port);
  expect(started).toHaveLength(1);
  notices.dispose();
  expect(started[0]?.terminated).toBe(true);
});

it("opens no further channels after its worker failed or could not start", () => {
  const worker = localNoticesWorker();
  const notices = new AttentionNotices(() => worker);
  const open = notices.open(counter());
  if (open !== undefined) ports.push(open.port);
  worker.fail();
  expect(notices.open(counter())).toBeUndefined();
  const unavailable = new AttentionNotices(() => { throw new Error("no nested workers"); });
  expect(unavailable.open(counter())).toBeUndefined();
});
