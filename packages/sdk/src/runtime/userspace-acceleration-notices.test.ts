import { afterEach, expect, it, vi } from "vitest";
import { UserspaceProcessBackend } from "./userspace-process.js";
import { integer, record } from "./decode.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { AccelerationNotice } from "./js-process/late-failure.js";

/** A control worker whose runtime answers initialize, dispose and one notice subscription. */
class NoticeWorker extends EventTarget {
  static instance: NoticeWorker | undefined;
  readonly ports: MessagePort[] = [];
  readonly subscribed = Promise.withResolvers<MessagePort>();
  constructor() { super(); NoticeWorker.instance = this; }
  postMessage(value: unknown): void {
    const input = record(value, "control request");
    const id = integer(input["id"], "request id", 1);
    const answer = () => { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: undefined } }))); };
    if (input["type"] === "dispose") { answer(); return; }
    if (input["type"] !== "attach-userspace") return;
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("Missing runtime port");
    this.ports.push(port);
    port.onmessage = (event: MessageEvent<unknown>) => {
      const request = record(event.data, "runtime request"), requestId = integer(request["id"], "id", 1);
      if (request["type"] === "acceleration-notices") {
        const channel = new MessageChannel();
        this.subscribed.resolve(channel.port1);
        port.postMessage({ version: PROTOCOL_VERSION, id: requestId, ok: true, value: channel.port2 }, [channel.port2]);
        return;
      }
      port.postMessage({ version: PROTOCOL_VERSION, id: requestId, ok: true, value: undefined });
    };
    answer();
  }
  terminate(): void { for (const port of this.ports) port.close(); }
}

async function backend(): Promise<{ readonly backend: UserspaceProcessBackend; readonly worker: NoticeWorker }> {
  vi.stubGlobal("Worker", NoticeWorker);
  const created = await UserspaceProcessBackend.create({ wasmUrl: "https://example.test/core.wasm", memoryMiB: 64 });
  const worker = NoticeWorker.instance;
  if (worker === undefined) throw new Error("No control worker");
  return { backend: created, worker };
}

const sqlite = { pid: 42, session: 40, kind: "unavailable-builtin", detail: "node:sqlite" } as const;

afterEach(() => { NoticeWorker.instance?.terminate(); NoticeWorker.instance = undefined; vi.unstubAllGlobals(); });

it("delivers each notice from the runtime's port and closes the subscription when the caller aborts", async () => {
  const { backend: runtime, worker } = await backend();
  const controller = new AbortController(), received: AccelerationNotice[] = [];
  const watching = runtime.watchAccelerationNotices(notice => { received.push(notice); }, controller.signal);
  const port = await worker.subscribed.promise;
  const closed = new Promise<unknown>(resolve => { port.onmessage = event => { resolve(event.data); }; });
  port.postMessage({ version: PROTOCOL_VERSION, notice: sqlite });
  await vi.waitFor(() => { expect(received).toHaveLength(1); });
  expect(received[0]).toEqual({ ...sqlite, message: "This program uses node:sqlite, which the fast path does not provide; its next run uses full Linux." });
  controller.abort();
  await expect(watching).resolves.toBeUndefined();
  expect(await closed).toEqual({ version: PROTOCOL_VERSION, type: "close" });
  await runtime.dispose();
});

it("rejects a malformed notice with PROTOCOL_ERROR and ends the subscription", async () => {
  const { backend: runtime, worker } = await backend();
  const watching = runtime.watchAccelerationNotices(() => {}, new AbortController().signal);
  const port = await worker.subscribed.promise;
  const closed = new Promise<unknown>(resolve => { port.onmessage = event => { resolve(event.data); }; });
  port.postMessage({ version: PROTOCOL_VERSION, notice: { ...sqlite, kind: "other" } });
  await expect(watching).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(await closed).toEqual({ version: PROTOCOL_VERSION, type: "close" });
  await runtime.dispose();
});

it("ends the watch when the runtime goes away", async () => {
  const { backend: runtime, worker } = await backend();
  const watching = runtime.watchAccelerationNotices(() => {}, new AbortController().signal);
  await worker.subscribed.promise;
  await runtime.dispose();
  await expect(watching).resolves.toBeUndefined();
  await expect(runtime.watchAccelerationNotices(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
