import { describe, expect, it } from "vitest";

import { embedderStorage, ORIGIN_STORAGE, type StorageScope } from "../storage-scope.js";
import { workspaceLockName } from "../workspace-path.js";
import { removeOpfsWorkspace, sweepEphemeralWorkspaces } from "./ephemeral-workspaces.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";

let sequence = 0;
/** An ephemeral workspace ID no other test uses, so locks never cross tests. */
function ephemeral(): string {
  sequence += 1;
  return `ephemeral_${sequence.toString(16).padStart(8, "0")}${Date.now().toString(16).padStart(24, "0").slice(-24)}`;
}

/** A scope root with each workspace's directory in both stores, as a VM leaves them. */
function root(...workspaces: string[]): MemoryDirectory {
  const oxidevm = new MemoryDirectory();
  for (const store of ["workspaces", "workspace-overlays"]) {
    const parent = oxidevm.directory(store, true);
    for (const id of workspaces) parent.directory(id, true).file("data", true);
  }
  return oxidevm;
}

function names(oxidevm: MemoryDirectory, store: string): readonly string[] {
  return [...oxidevm.directory(store, true).names()].sort();
}

/** Holds the workspace's lock, as a live VM's storage worker does, until the returned release. */
async function hold(scope: StorageScope, workspaceId: string): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<undefined>();
  const granted = Promise.withResolvers<undefined>();
  const lock = navigator.locks.request(workspaceLockName(scope, workspaceId), async () => { granted.resolve(undefined); await held.promise; });
  await granted.promise;
  return async () => { held.resolve(undefined); await lock; };
}

describe("ephemeral workspaces a closed tab left behind", () => {
  it("removes the ones no VM holds and keeps the live ones and every durable workspace", async () => {
    const [left, live] = [ephemeral(), ephemeral()];
    const oxidevm = root(left, live, "notes", "ephemeral_not-an-id");
    const release = await hold(ORIGIN_STORAGE, live);
    try {
      await expect(sweepEphemeralWorkspaces(oxidevm, ORIGIN_STORAGE, new AbortController().signal)).resolves.toBe(1);
    } finally { await release(); }
    for (const store of ["workspaces", "workspace-overlays"]) expect(names(oxidevm, store)).toEqual([live, "ephemeral_not-an-id", "notes"].sort());
  });

  it("checks the locks of its own storage scope", async () => {
    const id = ephemeral();
    const app = await embedderStorage("https://app.example.com");
    const docs = await embedderStorage("https://docs.example.com");
    const oxidevm = root(id);
    // A VM of app.example.com holds an ephemeral workspace of the same ID: docs.example.com's copy is still orphaned.
    const release = await hold(app, id);
    try {
      await expect(sweepEphemeralWorkspaces(oxidevm, docs, new AbortController().signal)).resolves.toBe(1);
      expect(names(oxidevm, "workspaces")).toEqual([]);
    } finally { await release(); }
  });

  it("treats missing stores as empty and stops when aborted", async () => {
    await expect(sweepEphemeralWorkspaces(new MemoryDirectory(), ORIGIN_STORAGE, new AbortController().signal)).resolves.toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    const oxidevm = root(ephemeral());
    await expect(sweepEphemeralWorkspaces(oxidevm, ORIGIN_STORAGE, aborted.signal)).rejects.toThrow();
    expect(names(oxidevm, "workspaces")).toHaveLength(1);
  });

  it("removes one workspace from both stores, also when one store lacks it", async () => {
    const [id, other] = [ephemeral(), ephemeral()];
    const oxidevm = root(id, other);
    await oxidevm.directory("workspace-overlays", true).removeEntry(id, { recursive: true });
    await removeOpfsWorkspace(oxidevm, id);
    await removeOpfsWorkspace(oxidevm, id);
    expect(names(oxidevm, "workspaces")).toEqual([other]);
    expect(names(oxidevm, "workspace-overlays")).toEqual([other]);
  });
});
