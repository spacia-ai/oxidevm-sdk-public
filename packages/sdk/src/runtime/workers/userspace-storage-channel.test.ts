import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeUserspaceStorageIncoming, UserspaceStorageClient, userspaceStorageFailure, userspaceStorageSuccess } from "./userspace-storage-channel.js";
import { VMError } from "../errors.js";
import { record } from "../decode.js";
import { decodeBytes } from "../protocol/decoders.js";

describe("Userspace storage channel", () => {
  it.each(["rootfs", "workspace"] as const)("retains the transferred %s response buffer", async kind => {
    const channel = new MessageChannel();
    const received = Promise.withResolvers<Uint8Array>();
    const source = new Uint8Array([1, 2, 3]);
    const sha256 = "a".repeat(64);
    channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
      const response = record(event.data, "test response");
      const value = response["value"];
      received.resolve(decodeBytes(kind === "rootfs" ? record(value, "rootfs")["bytes"] : value));
    });
    channel.port2.onmessage = (event: MessageEvent<unknown>) => {
      const request = decodeUserspaceStorageIncoming(event.data);
      if (request.type !== "cancel" && request.type !== "close") {
        channel.port2.postMessage(userspaceStorageSuccess(request.id,
          kind === "rootfs" ? { sha256, bytes: source } : source), [source.buffer]);
      }
    };
    const client = new UserspaceStorageClient(channel.port1);
    try {
      const result = kind === "rootfs" ? (await client.readRootfs("/bin/test")).bytes : await client.readWorkspace("/test");
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.buffer).toBe((await received.promise).buffer);
      expect(source.buffer.byteLength).toBe(0);
    } finally { client.close(); channel.port2.close(); }
  });

  it.each(["collect", "abort", "commit-capture"])("refuses Full-system operation %s on the workspace port", type => {
    expect(() => decodeUserspaceStorageIncoming({ version: PROTOCOL_VERSION, id: 1, type: "workspace", request: { type } })).toThrow();
  });

  it.each([1, 99])("fences pending workspace reads after duplicate or stale response %i", async staleId => {
    const channel = new MessageChannel(), client = new UserspaceStorageClient(channel.port1);
    channel.port2.onmessage = (event: MessageEvent<unknown>) => {
      const request = decodeUserspaceStorageIncoming(event.data);
      if (request.type !== "cancel" && request.type !== "close") channel.port2.postMessage(userspaceStorageSuccess(request.id === 1 ? 1 : staleId, new Uint8Array([42])));
    };
    try {
      await expect(client.readWorkspace("/first")).resolves.toEqual(new Uint8Array([42]));
      await expect(client.request({ type: "read-workspace-frame", source: "snapshot", offset: 0,
        identity: { session: "11111111-2222-4333-8444-555555555555", generation: 1, transfer: 1 } })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      await expect(client.readWorkspace("/after-failure")).rejects.toMatchObject({ code: "ABORTED" });
    } finally { client.close(); channel.port2.close(); }
  });

  it.each(["workspace", "root-open", "root-read", "root-retire"] as const)("fences a %s read whose owner never confirms completion", async kind => {
    vi.useFakeTimers();
    const channel = new MessageChannel(), client = new UserspaceStorageClient(channel.port1);
    const started = Promise.withResolvers<undefined>();
    channel.port2.onmessage = () => started.resolve(undefined);
    try {
      const pending = kind === "root-open" ? client.openRootOverlay("a".repeat(64), { session: "11111111-2222-4333-8444-555555555555", generation: 1 })
        : kind === "root-read" ? client.readRootFrame(1, 0)
        : kind === "root-retire" ? client.closeRootOverlay(1)
        : client.request({ type: "read-workspace-frame", source: "snapshot", offset: 0,
          identity: { session: "11111111-2222-4333-8444-555555555555", generation: 1, transfer: 1 } });
      const outcome = pending.then(() => "unexpected success", (error: unknown) => error);
      await started.promise;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({
        code: "STORAGE_ERROR", detail: { cleanupFailed: true },
      });
      await expect(client.readRootfs("/after-timeout")).rejects.toMatchObject({ code: "ABORTED" });
    } finally { client.close(); channel.port2.close(); vi.useRealTimers(); }
  });
  it("waits for the storage owner's cancellation outcome and accepts the next request", async () => {
    const channel = new MessageChannel();
    const started = Promise.withResolvers<number>();
    const cancelled = Promise.withResolvers<number>();
    const client = new UserspaceStorageClient(channel.port1);
    channel.port2.onmessage = (event: MessageEvent<unknown>) => {
      const request = decodeUserspaceStorageIncoming(event.data);
      if (request.type === "cancel") cancelled.resolve(request.requestId);
      else if (request.type !== "close") started.resolve(request.id);
    };
    try {
      const controller = new AbortController();
      const pending = client.readRootfs("/usr/bin/node", controller.signal);
      const outcome = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const id = await started.promise;
      controller.abort();
      expect(await cancelled.promise).toBe(id);
      expect(settled).toBe(false);
      channel.port2.postMessage(userspaceStorageFailure(id, new VMError("ABORTED", "read producer retired")));
      await outcome;
      channel.port2.onmessage = (event: MessageEvent<unknown>) => {
        const request = decodeUserspaceStorageIncoming(event.data);
        if (request.type !== "cancel" && request.type !== "close") channel.port2.postMessage(userspaceStorageSuccess(request.id, new Uint8Array([42])));
      };
      await expect(client.readWorkspace("/file")).resolves.toEqual(new Uint8Array([42]));
    } finally { client.close(); channel.port2.close(); }
  });

  it("retains the actual commit response when abort races publication", async () => {
    const channel = new MessageChannel();
    const started = Promise.withResolvers<number>();
    const cancelled = Promise.withResolvers<number>();
    channel.port2.onmessage = (event: MessageEvent<unknown>) => {
      const request = decodeUserspaceStorageIncoming(event.data);
      if (request.type === "cancel") cancelled.resolve(request.requestId);
      else if (request.type !== "close") started.resolve(request.id);
    };
    const client = new UserspaceStorageClient(channel.port1);
    try {
      const controller = new AbortController();
      const pending = client.commitWorkspaceSnapshot("b".repeat(64), new Uint8Array([42]), controller.signal);
      const id = await started.promise;
      controller.abort();
      // Inspect delivery in a later message turn without waiting forever when
      // the old client fails to send cancellation for commit operations.
      channel.port2.postMessage(userspaceStorageSuccess(id, 7));
      await expect(pending).resolves.toBe(7);
      expect(await cancelled.promise).toBe(id);
    } finally { client.close(); channel.port2.close(); }
  });

  it("returns an exact digest-qualified rootfs read", async () => {
    const bytes = new TextEncoder().encode("immutable executable");
    const sha256 = "a".repeat(64);
    const channel = new MessageChannel();
    channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      const request = event.data;
      if (typeof request !== "object" || request === null || !("id" in request) || typeof request.id !== "number") {
        throw new TypeError("Userspace storage request is invalid");
      }
      channel.port2.postMessage({
        version: PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        value: { sha256, bytes },
      });
    });
    channel.port2.start();

    const client = new UserspaceStorageClient(channel.port1);
    await expect(client.readRootfs("/usr/bin/bun")).resolves.toEqual({ sha256, bytes });
    client.close();
    channel.port2.close();
  });

  it("round-trips exact workspace snapshot identities and generations", async () => {
    const base = "b".repeat(64);
    const snapshot = new Uint8Array([1, 2, 3]);
    const channel = new MessageChannel();
    channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      const request = event.data;
      if (typeof request !== "object" || request === null || !("id" in request) || typeof request.id !== "number" || !("type" in request)) {
        throw new TypeError("Userspace workspace request is invalid");
      }
      channel.port2.postMessage({
        version: PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        value: request.type === "read-workspace-snapshot" ? snapshot : 7,
      });
    });
    channel.port2.start();

    const client = new UserspaceStorageClient(channel.port1);
    await expect(client.readWorkspaceSnapshot(base)).resolves.toEqual(snapshot);
    await expect(client.commitWorkspaceSnapshot(base, snapshot)).resolves.toBe(7);
    client.close();
    channel.port2.close();
  });
});

it("carries exact foreign workspace metadata over the native workspace port",async()=>{
 const channel=new MessageChannel(),client=new UserspaceStorageClient(channel.port1),metadata=new Uint8Array([79,88,82,70]);
 channel.port2.onmessage=(event:MessageEvent<unknown>)=>{const request=decodeUserspaceStorageIncoming(event.data);if(request.type==="workspace"&&request.request.type==="inspect-workspace-base")channel.port2.postMessage(userspaceStorageSuccess(request.id,{metadata}),[metadata.buffer]);};
 try {expect(await client.request({type:"inspect-workspace-base",workspaceBaseSha256:"a".repeat(64)})).toEqual({metadata:new Uint8Array([79,88,82,70])});expect(metadata.byteLength).toBe(0);}
 finally{client.close();channel.port2.close();}
});
