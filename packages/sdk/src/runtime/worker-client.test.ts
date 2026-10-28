import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import {
  type ControlOperations,
  controlResponseDecoders,
  storageResponseDecoders,
  type StorageOperations,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { WorkerClient } from "./worker-client.js";
import { decodeAttentionAttachment, isAttentionAttachment } from "./host-attention.js";

class FakeWorker {
  readonly messages: unknown[] = [];
  terminated = false;
  readonly #messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  postMessage(message: unknown, transfer: readonly Transferable[]): void {
    void transfer;
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: Event) => void),
  ): void {
    if (type === "message") this.#messageListeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: Event) => void),
  ): void {
    if (type === "message") this.#messageListeners.delete(listener);
  }

  respond(value: unknown): void {
    const event = new MessageEvent<unknown>("message", { data: value });
    for (const listener of this.#messageListeners) listener(event);
  }
}

describe("WorkerClient lifecycle", () => {
  it("rejects and fences a malformed terminal error after cancellation", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient<StorageOperations>(worker, storageResponseDecoders, "settled");
    const controller = new AbortController();
    const pending = client.request("read-workspace-snapshot", { workspaceBaseSha256: "b".repeat(64) }, { signal: controller.signal });
    controller.abort();
    worker.respond({ version: PROTOCOL_VERSION, id: 1, ok: false, error: { code: "invented", message: "invalid" } });
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(worker.terminated).toBe(true);
  });

  it.each([true, false])("awaits the storage owner's terminal reply after cancellation (committed=%s)", async committed => {
    const worker = new FakeWorker();
    const client = new WorkerClient<StorageOperations>(worker, storageResponseDecoders, "settled");
    const controller = new AbortController();
    const pending = client.request("commit-workspace-snapshot", {
      workspaceBaseSha256: "b".repeat(64), data: new Uint8Array([42]),
    }, { signal: controller.signal });
    const outcome = committed ? expect(pending).resolves.toBe(7) : expect(pending).rejects.toMatchObject({
      code: "STORAGE_ERROR", detail: { reason: "workspace-publication-uncertain" },
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(worker.messages.at(-1)).toEqual({ version: PROTOCOL_VERSION, type: "cancel", requestId: 1 });
    worker.respond(committed ? { version: PROTOCOL_VERSION, id: 1, ok: true, value: 7 } : {
      version: PROTOCOL_VERSION, id: 1, ok: false,
      error: { code: "STORAGE_ERROR", message: "publication acknowledgement lost", detail: { reason: "workspace-publication-uncertain" } },
    });
    await outcome;
    client.terminate();
  });

  it("sends cancellation and ignores only its late response", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient<ControlOperations>(
      worker,
      controlResponseDecoders,
    );
    const controller = new AbortController();
    const snapshotPort = new MessageChannel().port1;
    const pending = client.request(
      "initialize",
      {
        coreWasmUrl: "/core.wasm",
        sharedCoreWasmUrl: "/core-shared.wasm",
        workspaceId: "test",
        memoryMiB: 128,
        vcpus: 1,
        snapshotPort,
      },
      { signal: controller.signal },
    );
    controller.abort();

    expect(await rejectionCode(pending)).toBe("ABORTED");
    expect(worker.messages).toEqual([
      {
        id: 1,
        version: PROTOCOL_VERSION,
        type: "initialize",
        coreWasmUrl: "/core.wasm",
        sharedCoreWasmUrl: "/core-shared.wasm",
        workspaceId: "test",
        memoryMiB: 128,
        vcpus: 1,
        snapshotPort,
      },
      {
        version: PROTOCOL_VERSION,
        type: "cancel",
        requestId: 1,
      },
    ]);

    worker.respond({
      id: 1,
      version: PROTOCOL_VERSION,
      ok: true,
      value: undefined,
    });
    const next = client.request("dispose", undefined);
    worker.respond({
      id: 2,
      version: PROTOCOL_VERSION,
      ok: true,
      value: undefined,
    });
    await expect(next).resolves.toBeUndefined();
    expect(worker.terminated).toBe(false);
    client.terminate();
  });

  it("fails closed on unknown and malformed responses", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient<ControlOperations>(
      worker,
      controlResponseDecoders,
    );
    const pending = client.request("dispose", undefined);
    worker.respond({
      id: 99,
      version: PROTOCOL_VERSION,
      ok: true,
      value: undefined,
    });
    expect(await rejectionCode(pending)).toBe("PROTOCOL_ERROR");
    expect(worker.terminated).toBe(true);
    expect(await rejectionCode(client.request("dispose", undefined))).toBe(
      "PROTOCOL_ERROR",
    );
  });

  it("uses the operation decoder instead of caller-selected result types", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient<ControlOperations>(
      worker,
      controlResponseDecoders,
    );
    const pending = client.request("dispose", undefined);
    worker.respond({
      id: 1,
      version: PROTOCOL_VERSION,
      ok: true,
      value: "not undefined",
    });
    expect(await rejectionCode(pending)).toBe("PROTOCOL_ERROR");
    client.terminate();
  });
});

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
}

it("publishes one worker lifetime outcome even after its last RPC has completed", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const pending = client.request("assistance-prepare", undefined);
  worker.respond({ id: 1, version: PROTOCOL_VERSION, ok: true, value: { session: "11111111-2222-4333-8444-555555555555", generation: 1 } });
  await pending;
  expect(client.lifetime.aborted).toBe(false);
  worker.respond({ id: 1, version: PROTOCOL_VERSION, ok: true, value: {} });
  expect(client.lifetime.aborted).toBe(true);
  const reason: unknown = client.lifetime.reason;
  expect(reason).toMatchObject({ code: "PROTOCOL_ERROR" });
  client.terminate();
  expect(client.lifetime.reason).toBe(reason);
});

it("retains a supervisory termination reason for pending RPCs and returned handles", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const reason = new VMError("GUEST_CRASH", "control lifeline expired");
  const pending = expect(client.request("assistance-prepare", undefined)).rejects.toBe(reason);
  client.terminate(reason);
  await pending;
  expect(client.lifetime.reason).toBe(reason);
  await expect(client.request("assistance-prepare", undefined)).rejects.toBe(reason);
});

describe("WorkerClient host attention", () => {
  it("attaches its counter first and counts every request and cancellation it posts", async () => {
    const worker = new FakeWorker(), attention = new Int32Array(new SharedArrayBuffer(4));
    const client = new WorkerClient<StorageOperations>(worker, storageResponseDecoders, "settled", attention);
    // The attachment is the first message and is itself uncounted.
    expect(worker.messages).toHaveLength(1);
    expect(isAttentionAttachment(worker.messages[0])).toBe(true);
    expect(Atomics.load(decodeAttentionAttachment(worker.messages[0]), 0)).toBe(0);
    const controller = new AbortController();
    const pending = client.request("commit-workspace-snapshot", { workspaceBaseSha256: "b".repeat(64), data: new Uint8Array([1]) }, { signal: controller.signal });
    expect(Atomics.load(attention, 0)).toBe(1);
    controller.abort();
    expect(worker.messages.at(-1)).toEqual({ version: PROTOCOL_VERSION, type: "cancel", requestId: 1 });
    expect(Atomics.load(attention, 0)).toBe(2);
    worker.respond({ version: PROTOCOL_VERSION, id: 1, ok: true, value: 7 });
    await expect(pending).resolves.toBe(7);
    client.terminate();
  });

  it("does not count a request whose post threw", async () => {
    const attention = new Int32Array(new SharedArrayBuffer(4));
    const worker = new FakeWorker();
    const client = new WorkerClient<StorageOperations>(worker, storageResponseDecoders, "settled", attention);
    worker.postMessage = () => { throw new Error("clone failed"); };
    await expect(client.request("read-workspace-snapshot", { workspaceBaseSha256: "b".repeat(64) })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(Atomics.load(attention, 0)).toBe(0);
    client.terminate();
  });

  it("posts no attachment without a counter", () => {
    const worker = new FakeWorker();
    const client = new WorkerClient<StorageOperations>(worker, storageResponseDecoders, "settled", null);
    expect(worker.messages).toHaveLength(0);
    client.terminate();
  });
});
