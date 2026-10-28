import { expect, it } from "vitest";
import { droppedStreamReferences, type StreamWorkspaceManifest } from "./workspace-manifest.js";
import type { WorkspaceStreamRef } from "./workspace-stream.js";

const base = "a".repeat(64);
const inputsSha256 = "b".repeat(64);
const reference = (bytes: number): WorkspaceStreamRef => ({ bytes, pages: [] });
const manifest = (snapshot: WorkspaceStreamRef, delta: WorkspaceStreamRef,
  tree?: WorkspaceStreamRef): StreamWorkspaceManifest => ({
  formatVersion: 2, generation: 1, workspaceBaseSha256: base, snapshot, delta,
  ...(tree === undefined ? {} : { dependencies: { generation: inputsSha256, inputsSha256, tree } }),
});

it("drops only the previous delta when the successor reuses the snapshot", () => {
  const snapshot = reference(3), delta = reference(9);
  const dropped = droppedStreamReferences(manifest(snapshot, delta), manifest(snapshot, reference(10)));
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toBe(delta);
});

it("names nothing when the successor carries every reference over", () => {
  const snapshot = reference(3), delta = reference(9), tree = reference(5);
  expect(droppedStreamReferences(manifest(snapshot, delta, tree), manifest(snapshot, delta, tree))).toEqual([]);
});

it("keeps a dependency tree the successor carries over by identity", () => {
  const snapshot = reference(3), delta = reference(9), tree = reference(5);
  const dropped = droppedStreamReferences(manifest(snapshot, delta, tree), manifest(snapshot, reference(10), tree));
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toBe(delta);
});

it("names a dependency tree the successor removes", () => {
  const snapshot = reference(3), delta = reference(9), tree = reference(5);
  const dropped = droppedStreamReferences(manifest(snapshot, delta, tree), manifest(snapshot, delta));
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toBe(tree);
});

it("counts an equal reference held in a different object as dropped", () => {
  const snapshot = reference(3), delta = reference(9);
  const dropped = droppedStreamReferences(manifest(snapshot, delta), manifest(reference(3), delta));
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toBe(snapshot);
});
