import { afterEach, expect, it, vi } from "vitest";
import { UserspaceProcessBackend } from "./userspace-process.js";
import { integer, record } from "./decode.js";
import { PROTOCOL_VERSION } from "./protocol.js";

/** A control worker whose Userspace side answers a module-commands request only once the page cancels it. */
class AnsweringWorker extends EventTarget {
  static instance: AnsweringWorker | undefined;
  readonly received: Readonly<Record<string, unknown>>[] = [];
  port: MessagePort | undefined;
  constructor() { super(); AnsweringWorker.instance = this; }
  postMessage(input: unknown): void {
    const request = record(input, "control request"), id = integer(request["id"], "id", 1), port = request["port"];
    if (!(port instanceof MessagePort)) throw new Error("Missing runtime port");
    this.port = port;
    let pending: number | undefined;
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = record(event.data, "runtime request");
      this.received.push(message);
      if (message["type"] === "module-commands") { pending = integer(message["id"], "id", 1); return; }
      // The owner had registered before the cancellation arrived, and answers the request with its registration.
      if (message["type"] === "cancel") { port.postMessage({ id: pending, version: PROTOCOL_VERSION, ok: true, value: { operation: "enable", registration: 7, commands: ["alpha"], skipped: [] } }); return; }
      port.postMessage({ id: integer(message["id"], "id", 1), version: PROTOCOL_VERSION, ok: true, value: undefined });
    };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: undefined } })));
  }
  terminate(): void { this.port?.close(); }
}

afterEach(() => { AnsweringWorker.instance?.terminate(); AnsweringWorker.instance = undefined; vi.unstubAllGlobals(); });

// Engine ADR 0027: an enable the page cancels may already have registered; only the owner's answer says so.
it("waits for the owner's answer to a module-commands request the page cancelled", async () => {
  vi.stubGlobal("Worker", AnsweringWorker);
  const backend = await UserspaceProcessBackend.create({ wasmUrl: "https://example.test/core.wasm", memoryMiB: 64 });
  const worker = AnsweringWorker.instance;
  if (worker === undefined) throw new Error("Missing worker");
  const controller = new AbortController();
  const enabling = backend.moduleCommands({ operation: "enable", descriptor: "{}", commands: ["alpha"], concurrency: 4 }, controller.signal);
  await vi.waitFor(() => { expect(worker.received.some(message => message["type"] === "module-commands")).toBe(true); });
  controller.abort();
  await expect(enabling).resolves.toEqual({ operation: "enable", registration: 7, commands: ["alpha"], skipped: [] });
  const sent = worker.received.find(message => message["type"] === "module-commands");
  expect(sent).toEqual({ id: sent?.["id"], version: PROTOCOL_VERSION, type: "module-commands", operation: "enable", descriptor: "{}", commands: ["alpha"], concurrency: 4 });
  expect(worker.received.at(-1)).toEqual({ version: PROTOCOL_VERSION, type: "cancel", requestId: sent?.["id"] });
  await backend.dispose().catch(() => undefined);
  await expect(backend.moduleCommands({ operation: "status", registration: 7 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
