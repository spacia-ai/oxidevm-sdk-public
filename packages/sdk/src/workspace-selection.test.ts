import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./runtime/errors.js";
import { embedderStorage, ORIGIN_STORAGE, type StorageScope } from "./runtime/storage-scope.js";
import { workspaceInUseError, workspaceLockName } from "./runtime/workspace-path.js";
import { decodePublicVMOptions, type ValidatedVMOptions } from "./vm-options.js";
import { openOnWorkspace } from "./workspace-selection.js";

let sequence = 0;
/** A workspace no other test uses, so locks never cross tests. */
function workspace(): string {
  sequence += 1;
  return `selection-${String(sequence)}-${Date.now().toString(36)}`;
}

/** Holds the workspace's lock, as another VM's storage worker does, until the returned release. */
async function hold(scope: StorageScope, workspaceId: string): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<undefined>();
  const granted = Promise.withResolvers<undefined>();
  const lock = navigator.locks.request(workspaceLockName(scope, workspaceId), async () => { granted.resolve(undefined); await held.promise; });
  await granted.promise;
  return async () => { held.resolve(undefined); await lock; };
}

/** Records the workspace each open attempt used; `fail` decides what an attempt does. */
function opener(fail: (options: ValidatedVMOptions) => Error | undefined = () => undefined) {
  const opened: ValidatedVMOptions[] = [];
  const open = vi.fn((options: ValidatedVMOptions) => {
    opened.push(options);
    const failure = fail(options);
    return failure === undefined ? Promise.resolve(options.workspaceId) : Promise.reject(failure);
  });
  return { opened, open };
}

describe("choosing the workspace a new VM opens", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("opens a free durable workspace as asked", async () => {
    const id = workspace();
    const { opened, open } = opener();
    await expect(openOnWorkspace(decodePublicVMOptions({ mode: "userspace", workspaceId: id, workspaceInUse: "temporary" }), ORIGIN_STORAGE, open)).resolves.toBe(id);
    expect(opened).toEqual([expect.objectContaining({ workspaceId: id, ephemeral: false })]);
  });

  it("opens a temporary workspace when another VM of the same scope holds the durable one", async () => {
    const id = workspace();
    const release = await hold(ORIGIN_STORAGE, id);
    try {
      const { opened, open } = opener();
      const temporary = await openOnWorkspace(decodePublicVMOptions({ mode: "system", workspaceId: id, workspaceInUse: "temporary" }), ORIGIN_STORAGE, open);
      expect(temporary).toMatch(/^ephemeral_/u);
      expect(opened).toEqual([expect.objectContaining({ workspaceId: temporary, ephemeral: "workspace-in-use" })]);
    } finally { await release(); }
  });

  it("opens the durable workspace of its own scope while another scope holds the same ID", async () => {
    const id = workspace();
    const app = await embedderStorage("https://app.example.com");
    const docs = await embedderStorage("https://docs.example.com");
    const release = await hold(app, id);
    try {
      const { opened, open } = opener();
      await expect(openOnWorkspace(decodePublicVMOptions({ mode: "userspace", workspaceId: id, workspaceInUse: "temporary" }), docs, open)).resolves.toBe(id);
      expect(opened).toEqual([expect.objectContaining({ workspaceId: id, ephemeral: false })]);
    } finally { await release(); }
  });

  it("falls back to a temporary workspace when another tab takes the durable one first", async () => {
    // The lock was free when checked, then another tab's VM took it before this VM's storage worker did.
    const { opened, open } = opener(options => options.ephemeral === false ? workspaceInUseError(options.workspaceId) : undefined);
    const temporary = await openOnWorkspace(decodePublicVMOptions({ mode: "userspace", workspaceId: workspace(), workspaceInUse: "temporary" }), ORIGIN_STORAGE, open);
    expect(opened.map(options => options.ephemeral)).toEqual([false, "workspace-in-use"]);
    expect(temporary).toBe(opened[1]?.workspaceId);
  });

  it("keeps failing on a workspace in use by default, and never retries other failures", async () => {
    const id = workspace();
    const release = await hold(ORIGIN_STORAGE, id);
    try {
      const inUse = opener(options => workspaceInUseError(options.workspaceId));
      await expect(openOnWorkspace(decodePublicVMOptions({ mode: "userspace", workspaceId: id }), ORIGIN_STORAGE, inUse.open)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "workspace-in-use" } });
      expect(inUse.opened).toEqual([expect.objectContaining({ workspaceId: id })]);
    } finally { await release(); }
    const quota = opener(() => new VMError("QUOTA_EXCEEDED", "full"));
    await expect(openOnWorkspace(decodePublicVMOptions({ mode: "userspace", workspaceId: workspace(), workspaceInUse: "temporary" }), ORIGIN_STORAGE, quota.open)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(quota.opened).toHaveLength(1);
  });

  it("opens an ephemeral workspace without looking at any lock", async () => {
    const request = vi.spyOn(navigator.locks, "request");
    const { opened, open } = opener();
    await openOnWorkspace(decodePublicVMOptions({ mode: "userspace" }), ORIGIN_STORAGE, open);
    expect(opened).toEqual([expect.objectContaining({ ephemeral: "no-workspace-id" })]);
    expect(request).not.toHaveBeenCalled();
  });
});
