import {WORKSPACE_PUBLICATION_BYTES} from "../protocol/workspace-publication.js";
import {decodeWorkspaceReadRequest,decodeWorkspaceReadSelection} from "../protocol/workspace-read.js";
import { describe, expect, it, vi } from "vitest";

import { VMError } from "../errors.js";
import {
  decodeSnapshotStorageRequest,
  SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS,
  SNAPSHOT_CHANNEL_VERSION,
  SnapshotStorageClient,
  snapshotStorageResponse,
} from "./snapshot-channel.js";

describe("snapshot worker channel", () => {
  const snapshot = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  it("decodes bounded native transfers and rejects the previous channel authority", () => {
    const request = (body: Readonly<Record<string, unknown>>, version = SNAPSHOT_CHANNEL_VERSION) =>
      decodeSnapshotStorageRequest({ version, id: 1, request: body }).request;
    const open = { type: "open-native-capture", snapshot, kind: "automatic", memoryBytes: 256 * 1024 ** 2,
      workspaceBaseSha256: "a".repeat(64), rootPersistence: "persistent" };
    expect(request(open)).toEqual(open);
    expect(request({ ...open, baseline: snapshot })).toEqual({ ...open, baseline: snapshot });
    expect(request({ type: "seal-native-capture", capturedAtUnixMs: 1, graphBytes: 100, payloadBytes: 0 })).toMatchObject({ graphBytes: 100 });
    expect(request({ type: "put-native-chunk", area: "graph", index: 0, data: new Uint8Array([1]) })).toMatchObject({ area: "graph" });
    for (const bad of [
      { ...open, rootPersistence: "unknown" }, { ...open, workspaceBaseSha256: "bad" },
      { ...open, baseline: { ...snapshot, id: "wrong" } },
      { type: "put-native-chunk", area: "ram", index: 0, data: new Uint8Array([1]) },
      { type: "put-native-chunk", area: "graph", index: 0, data: new Uint8Array(1024 ** 2 + 1) },
      { type: "seal-native-capture", capturedAtUnixMs: 1, graphBytes: 0, payloadBytes: 0 },
    ]) expect(() => request(bad)).toThrow();
    expect(() => request(open, 8)).toThrow();
  });

  it("opens a capture before the cut and seals it with ordered bounded chunks", () => {
    const request = (body: Record<string, unknown>) =>
      decodeSnapshotStorageRequest({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, request: body }).request;
    const open = { type: "open-capture", snapshot, kind: "named", memoryBytes: 16 * 1024 * 1024, vcpus: 1 } as const;
    const seal = {
      type: "seal-capture",
      capturedAtUnixMs: 1,
      machineRecord: new Uint8Array([1]),
      ramChunks: [0, 2],
      disk: { kind: "none", bytes: 0, chunks: [] },
    } as const;

    expect(request(open)).toEqual(open);
    expect(request({ ...open, label: "bun dev", parentId: snapshot.id })).toMatchObject({
      label: "bun dev",
      parentId: snapshot.id,
    });
    expect(request(seal)).toMatchObject({ type: "seal-capture", ramChunks: [0, 2] });
    expect(request({ ...seal, agentState: new Uint8Array([2]) })).toMatchObject({ agentState: new Uint8Array([2]) });
    for (const malformed of [
      { ...open, kind: "favourite" },
      { ...open, capturedAtUnixMs: 1 },
      { ...seal, ramChunks: [2, 2] },
      { ...seal, snapshot },
      { ...open, ...seal, type: "begin-capture" },
    ]) {
      expect(() => request(malformed)).toThrow(VMError);
    }
    expect(() =>
      decodeSnapshotStorageRequest({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, request: open, extra: true }),
    ).toThrow(VMError);
  });

  it("asks storage to collect what no restore point needs, with nothing else", () => {
    const request = (body: Record<string, unknown>) =>
      decodeSnapshotStorageRequest({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, request: body }).request;

    expect(request({ type: "collect" })).toEqual({ type: "collect" });
    expect(() => request({ type: "collect", everything: true })).toThrow(VMError);
  });

  it("carries a restore stream's port and refuses the retired per-chunk read", () => {
    const { port1, port2 } = new MessageChannel();
    const request = (body: Record<string, unknown>, version: number = SNAPSHOT_CHANNEL_VERSION) =>
      decodeSnapshotStorageRequest({ version, id: 1, request: body });

    expect(request({ type: "stream-restore", port: port1 }).request).toEqual({ type: "stream-restore", port: port1 });
    expect(() => request({ type: "stream-restore", port: "port" })).toThrow(VMError);
    expect(() => request({ type: "read-restore-chunk", area: "ram", index: 0 })).toThrow(VMError);
    expect(() => request({ type: "abort" }, 6)).toThrow(VMError);
    port1.close();
    port2.close();
  });
});


it("fails a capture request storage does not answer in time and ignores its late answer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ports = new MessageChannel();
  ports.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    const { id, request } = decodeSnapshotStorageRequest(event.data);
    // Storage answers every request but the commit.
    if (request.type !== "commit-capture") ports.port1.postMessage(snapshotStorageResponse(id, undefined));
  });
  ports.port1.start();
  const client = new SnapshotStorageClient(ports.port2);
  try {
    const stalled = client.request({ type: "commit-capture" }).then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS);
    expect(await stalled).toMatchObject({
      code: "STORAGE_ERROR",
      detail: { reason: "storage-timeout", request: "commit-capture" },
    });
    // The late answer is ignored, and the channel keeps answering.
    ports.port1.postMessage(snapshotStorageResponse(1, undefined));
    await expect(client.request({ type: "abort" })).resolves.toBeUndefined();
  } finally {
    client.close();
    ports.port1.close();
    vi.useRealTimers();
  }
});


it("admits closed foreign-base reads and rejects unbound body authority",()=>{
 const hash="a".repeat(64),decode=(body:Record<string,unknown>)=>decodeSnapshotStorageRequest({version:SNAPSHOT_CHANNEL_VERSION,id:1,request:body}).request;
 expect(decode({type:"inspect-workspace-base",workspaceBaseSha256:hash})).toEqual({type:"inspect-workspace-base",workspaceBaseSha256:hash});
 expect(()=>decode({type:"inspect-workspace-base",workspaceBaseSha256:"bad"})).toThrow();
 expect(decodeWorkspaceReadSelection({generation:1,delta:0,workspaceBaseSha256:hash})?.workspaceBaseSha256).toBe(hash);
 const credit={kind:"grant",session:"11111111-2222-4333-8444-555555555555",generation:1,sequence:1,reservation:1,producer:"storage",process:null,pool:"data",bytes:WORKSPACE_PUBLICATION_BYTES,entries:1};
 const input={workspaceBaseSha256:hash,credit};
 expect(decodeWorkspaceReadRequest({...input,selection:{kind:"workspace-base-file",path:"/workspace/app",sha256:hash,bytes:3}}).selection).toMatchObject({kind:"workspace-base-file"});
 expect(()=>decodeWorkspaceReadRequest({...input,selection:{kind:"workspace-base-file",path:"/workspace/app",sha256:hash,bytes:3,snapshotId:"11111111-2222-4333-8444-555555555555"}})).toThrow();
 expect(()=>decodeWorkspaceReadRequest({...input,selection:{kind:"retained",id:"11111111-2222-4333-8444-555555555555",allowDifferentBase:false}})).toThrow();
});
