import { expect, it } from "vitest";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.js";
import { decodeWorkspaceReadIdentity, decodeWorkspaceReadRequest, decodeWorkspaceReadSelection } from "./workspace-read.js";
import { WORKSPACE_PUBLICATION_BYTES } from "./workspace-publication.js";
import { decodeSnapshotStorageRequest, SNAPSHOT_CHANNEL_VERSION } from "../workers/snapshot-channel.js";

it("validates exact read authority, metadata bounds, and versioned restore requests", () => {
  const credit = { session: "11111111-2222-4333-8444-555555555555", generation: 1, sequence: 1, reservation: 1,
    producer: "storage", process: null, kind: "grant", pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 };
  const input = { workspaceBaseSha256: "a".repeat(64), credit };
  expect(decodeWorkspaceReadRequest(input)).toEqual(input);
  for (const patch of [{ producer: "network" }, { kind: "return" }, { pool: "control" }, { bytes: 1 }, { entries: 2 }]) {
    expect(() => decodeWorkspaceReadRequest({ ...input, credit: { ...credit, ...patch } })).toThrow();
  }
  const identity = { session: credit.session, generation: 1, transfer: 1 };
  expect(decodeWorkspaceReadIdentity(identity)).toEqual(identity);
  expect(() => decodeWorkspaceReadIdentity({ ...identity, process: 1 })).toThrow();
  for (const selected of [{ generation: 0 }, { generation: 1 }, { generation: 1, snapshot: -1 }, { generation: 1, delta: 1024 ** 4 + 1 }, { generation: 1, extra: true },
    { generation: 1, dependencies: { generation: "x", inputsSha256: "b".repeat(64), tree: 1 } }]) {
    expect(() => decodeWorkspaceReadSelection(selected)).toThrow();
  }
  const read = { version: SNAPSHOT_CHANNEL_VERSION, id: 1, request: { type: "read-workspace-frame", identity, source: "delta", offset: 0 } };
  expect(decodeSnapshotStorageRequest(read)).toMatchObject({ id: 1, request: read.request });
  for (const request of [{ ...read.request, offset: -1 }, { ...read.request, source: "rootfs" }, { ...read.request, extra: true }]) {
    expect(() => decodeSnapshotStorageRequest({ ...read, request })).toThrow();
  }
  expect(() => decodeSnapshotStorageRequest({ ...read, version: 2 })).toThrow();
  const restore = { version: PROTOCOL_VERSION, id: 1, type: "agent-restore-workspace", workspaceBaseSha256: input.workspaceBaseSha256 };
  expect(decodeControlIncoming(restore)).toEqual(restore);
  expect(() => decodeControlIncoming({ ...restore, version: 31 })).toThrow();
  expect(() => decodeControlIncoming({ ...restore, workspaceBaseSha256: "invalid" })).toThrow();
});
