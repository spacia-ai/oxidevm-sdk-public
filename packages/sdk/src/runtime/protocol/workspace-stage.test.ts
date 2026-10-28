import { expect, it } from "vitest";
import { decodeWorkspaceStageResult } from "./workspace-stage.js";
import { decodeSnapshotStorageRequest, SNAPSHOT_CHANNEL_VERSION } from "../workers/snapshot-channel.js";

it("separates staged identities from confirmed credit returns and rejects older storage dialects", () => {
  const selection = { generation: 2, snapshot: 12, delta: 12, dependencies: { generation: "a".repeat(64), inputsSha256: "b".repeat(64), tree: 20 } };
  expect(decodeWorkspaceStageResult({ kind: "staged", selection })).toEqual({ kind: "staged", selection });
  for (const value of [
    { kind: "staged", selection: undefined }, { kind: "staged", selection, credit: {} },
    { kind: "staged", selection: { ...selection, generation: 0 } },
    { kind: "finished", result: { retired: false, outcome: { kind: "committed", generation: 2 } } },
    { kind: "finished", result: { retired: false, outcome: { kind: "failed", error: {} } } },
  ]) expect(() => decodeWorkspaceStageResult(value)).toThrow();
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, transfer: 2 };
  const envelope = { version: SNAPSHOT_CHANNEL_VERSION, id: 1, request: { type: "finish-workspace-stage", identity, decision: "commit" } };
  expect(decodeSnapshotStorageRequest(envelope)).toEqual({ id: envelope.id, request: envelope.request });
  for (const version of [1, 2, 3]) expect(() => decodeSnapshotStorageRequest({ ...envelope, version })).toThrow();
  for (const decision of [undefined, "rollback", 1]) expect(() => decodeSnapshotStorageRequest({ ...envelope, request: { ...envelope.request, decision } })).toThrow();
  expect(() => decodeSnapshotStorageRequest({ ...envelope, request: { ...envelope.request, extra: true } })).toThrow();
});
