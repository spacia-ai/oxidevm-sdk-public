import { afterEach, expect, it, vi } from "vitest";
import { attachUserspaceExecution, closeUserspaceExecution } from "./userspace.js";
import { PROTOCOL_VERSION } from "../../protocol/common.js";
import { decodeAttentionAttachment, isAttentionAttachment } from "../../host-attention.js";

class ExecutionWorker extends EventTarget {
  static readonly instances: ExecutionWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = 0;
  constructor() { super(); ExecutionWorker.instances.push(this); }
  postMessage(message: unknown, transfer: Transferable[] = []): void { this.posted.push(structuredClone(message, { transfer })); }
  terminate(): void { this.terminated += 1; }
}

const ports: MessagePort[] = [];
afterEach(() => {
  closeUserspaceExecution();
  for (const port of ports.splice(0)) port.close();
  ExecutionWorker.instances.length = 0;
  vi.unstubAllGlobals();
});

function execution(nativeExecutionPort?: MessagePort) {
  vi.stubGlobal("Worker", ExecutionWorker);
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  attachUserspaceExecution(channel.port2);
  const worker = ExecutionWorker.instances.at(-1);
  if (worker === undefined) throw new Error("Execution worker was not created");
  const request = (id: number): Promise<unknown> => {
    const response = Promise.withResolvers<unknown>();
    channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => { response.resolve(event.data); }, { once: true });
    channel.port1.start();
    channel.port1.postMessage({ id, version: PROTOCOL_VERSION, type: "initialize", wasmUrl: "/core.wasm", memoryMiB: 256,
      ...(nativeExecutionPort === undefined ? {} : { nativeExecutionPort }) }, nativeExecutionPort === undefined ? [] : [nativeExecutionPort]);
    return response.promise;
  };
  return { worker, request };
}

it("transfers the isolated native capability through the control worker", async () => {
  const capability = new MessageChannel(); ports.push(capability.port1, capability.port2);
  const { worker, request } = execution(capability.port1);
  const response = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  expect(worker.posted[0]).toHaveProperty("nativeExecutionPort");
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, ok: true } }));
  await expect(response).resolves.toMatchObject({ id: 1, ok: true });
});

it("remembers an execution worker failure before the first request", async () => {
  const { worker, request } = execution();
  worker.dispatchEvent(new Event("error"));
  await expect(request(1)).resolves.toMatchObject({ id: 1, ok: false, error: { code: "PROTOCOL_ERROR" } });
  expect(worker.posted).toEqual([]);
  expect(worker.terminated).toBe(1);
}, 1000);

it("settles pending and subsequent requests after a clone failure", async () => {
  const { worker, request } = execution();
  const pending = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  worker.dispatchEvent(new Event("messageerror"));
  await expect(pending).resolves.toMatchObject({ id: 1, ok: false, error: { code: "PROTOCOL_ERROR" } });
  await expect(request(2)).resolves.toMatchObject({ id: 2, ok: false, error: { code: "PROTOCOL_ERROR" } });
  expect(worker.posted).toHaveLength(1);
}, 1000);

it("isolates a replacement channel from callbacks of the retired worker", async () => {
  const old = execution();
  const current = execution();
  const response = current.request(3);
  await vi.waitFor(() => expect(current.worker.posted).toHaveLength(1));
  old.worker.dispatchEvent(new Event("error"));
  current.worker.dispatchEvent(new MessageEvent("message", { data: { id: 3, version: PROTOCOL_VERSION, ok: true } }));
  await expect(response).resolves.toMatchObject({ id: 3, ok: true });
  expect(current.worker.terminated).toBe(0);
}, 1000);

it("attaches a host attention counter first and counts every request it forwards", async () => {
  vi.stubGlobal("crossOriginIsolated", true);
  const { worker, request } = execution();
  // The attachment precedes every request and is itself uncounted.
  expect(worker.posted).toHaveLength(1);
  const attachment = worker.posted[0];
  expect(isAttentionAttachment(attachment)).toBe(true);
  const counter = decodeAttentionAttachment(attachment);
  expect(Atomics.load(counter, 0)).toBe(0);
  const first = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
  expect(Atomics.load(counter, 0)).toBe(1);
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, ok: true } }));
  await expect(first).resolves.toMatchObject({ id: 1, ok: true });
  const second = request(2);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(3));
  expect(Atomics.load(counter, 0)).toBe(2);
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 2, version: PROTOCOL_VERSION, ok: true } }));
  await expect(second).resolves.toMatchObject({ id: 2, ok: true });
}, 1000);

it("forwards without a counter where shared memory is unavailable", async () => {
  vi.stubGlobal("crossOriginIsolated", false);
  const { worker, request } = execution();
  const response = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  expect(isAttentionAttachment(worker.posted[0])).toBe(false);
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, ok: true } }));
  await expect(response).resolves.toMatchObject({ id: 1, ok: true });
}, 1000);

it("moves a port the execution worker answers with on to the page", async () => {
  const { worker, request } = execution();
  const response = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  const notices = new MessageChannel(); ports.push(notices.port1, notices.port2);
  // The worker's reply transfers the subscription's port, as its acceleration-notices answer does.
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, ok: true, value: notices.port2 } }));
  const reply = await response;
  expect(reply).toMatchObject({ id: 1, ok: true });
  const value: unknown = Reflect.get(Object(reply), "value");
  if (!(value instanceof MessagePort)) throw new Error("The page did not receive the port");
  ports.push(value);
  const received = new Promise<unknown>(resolve => { value.onmessage = event => { resolve(event.data); }; });
  notices.port1.postMessage("notice");
  await expect(received).resolves.toBe("notice");
});

it("answers a reply it cannot forward with an error instead of stranding the request", async () => {
  const { worker, request } = execution();
  const response = request(1);
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, ok: true, value: () => 1 } }));
  await expect(response).resolves.toMatchObject({ id: 1, ok: false, error: { code: "PROTOCOL_ERROR" } });
});
