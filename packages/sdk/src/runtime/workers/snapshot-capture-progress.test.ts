import { expect, it, vi } from "vitest";
import {
  decodeSnapshotStorageRequest, SNAPSHOT_CHANNEL_VERSION, SnapshotStorageClient,
  SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS as TIMEOUT, snapshotStorageResponse,
} from "./snapshot-channel.js";

const request = {
  type: "open-native-capture", snapshot: { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-13T00:00:00.000Z" },
  kind: "named", memoryBytes: 128 * 1024 ** 2, workspaceBaseSha256: "a".repeat(64), rootPersistence: "ephemeral",
} as const;

function fixture() {
  const ports = new MessageChannel(), client = new SnapshotStorageClient(ports.port2);
  const started = Promise.withResolvers<undefined>(), cancelled = Promise.withResolvers<number>();
  ports.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    const { id, request } = decodeSnapshotStorageRequest(event.data);
    if (request.type === "open-native-capture") started.resolve(undefined);
    else {
      if (request.type === "cancel-workspace-operation") cancelled.resolve(request.requestId);
      ports.port1.postMessage(snapshotStorageResponse(id, undefined));
    }
  });
  ports.port1.start();
  return { client, started, cancelled,
    progress: (completedObjects: number) => ports.port1.postMessage({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, completedObjects }),
    finish: () => ports.port1.postMessage(snapshotStorageResponse(1, undefined)),
    barrier: () => client.request({ type: "native-session" }),
    close: () => { client.close(); ports.port1.close(); },
  };
}

it("keeps a cold image capture alive while verified objects advance beyond the request deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  try {
    const result = f.client.request(request);
    // Attach immediately so a premature timeout is reported by this assertion.
    const outcome = result.then(() => "saved", (error: unknown) => error);
    await f.started.promise;
    for (let object = 1; object <= 4; object++) {
      await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
      f.progress(object);
      await f.barrier();
    }
    f.finish();
    expect(await outcome).toBe("saved");
  } finally { f.close(); vi.useRealTimers(); }
});

it("cancels a native capture when verified-object progress stops and ignores its late replies", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  try {
    const outcome = f.client.request(request).catch((error: unknown) => error);
    await f.started.promise;
    f.progress(1); await f.barrier();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(await outcome).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "storage-timeout" } });
    expect(await f.cancelled.promise).toBe(1);
    f.progress(2); f.finish();
    await expect(f.client.request({ type: "abort" })).resolves.toBeUndefined();
  } finally { f.close(); vi.useRealTimers(); }
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects malformed capture progress %s", async completedObjects => {
  const f = fixture();
  try {
    const outcome = f.client.request(request).catch((error: unknown) => error);
    await f.started.promise; f.progress(completedObjects);
    expect(await outcome).toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { f.close(); }
});

it("rejects repeated progress instead of allowing a stalled producer to refresh its deadline", async () => {
  const f = fixture();
  try {
    const outcome = f.client.request(request).catch((error: unknown) => error);
    await f.started.promise; f.progress(1); await f.barrier(); f.progress(1);
    expect(await outcome).toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { f.close(); }
});

it("rejects capture progress on a different operation", async () => {
  const ports = new MessageChannel(), client = new SnapshotStorageClient(ports.port2);
  ports.port1.addEventListener("message", () => {
    ports.port1.postMessage({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, completedObjects: 1 });
  });
  ports.port1.start();
  try { await expect(client.request({ type: "commit-capture" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" }); }
  finally { client.close(); ports.port1.close(); }
});
