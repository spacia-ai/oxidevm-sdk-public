import { expect, it } from "vitest";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { WorkspaceStore } from "./workspace-store.js";

it.each([
  ["workspace", "release"], ["root", "release"],
  ["workspace", "collect"], ["root", "collect"],
  ["workspace", "abort"], ["root", "abort"],
] as const)("keeps %s recovery's enumerated generation alive through %s", async (scope, operation) => {
  const raw = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>();
  let armed = false;
  const selections = new WorkspaceSelections({ ...raw, async *list(prefix) {
    for await (const path of raw.list(prefix)) {
      if (armed && prefix === "selections/kept/") {
        armed = false; entered.resolve(undefined); await resume.promise;
      }
      yield path;
    }
  } });
  const base = "a".repeat(64), id = crypto.randomUUID(), signal = new AbortController().signal;
  const store = scope === "root" ? await openUserspaceRootStore(selections.backend, base) : new WorkspaceStore(selections.backend);
  await store.commitStreams(base, { snapshot: workspaceBytesInput(new Uint8Array([7])), delta: workspaceBytesInput(new Uint8Array()) }, signal);
  const staged = operation === "abort" ? await selections.stage(id, scope === "root" ? base : undefined) : undefined;
  if (staged === undefined) await selections.retain(id, scope === "root" ? base : undefined);
  const reopened = scope === "root" ? await openUserspaceRootStore(selections.backend, base) : new WorkspaceStore(selections.backend);
  armed = true;
  const reading = reopened.read(base);
  void reading.catch(() => {});
  await entered.promise;
  const releasing = staged !== undefined ? staged.abort()
    : operation === "release" ? selections.release(id) : selections.collect(new Set());
  try {
    // Let the unguarded release finish in the regression; the fixed owner queues it.
    await Promise.race([releasing, new Promise<void>(resolve => setTimeout(resolve, 25))]);
  } finally { resume.resolve(undefined); }
  expect(await reading).toEqual(new Uint8Array([7]));
  await releasing;
  expect(await selections.has(id)).toBe(false);
});

it("retires a released source inside a publication without recursively waiting for its mutation turn", async () => {
  const selections = new WorkspaceSelections(opfsWorkspaceStoreBackend(new MemoryDirectory()));
  const store = new WorkspaceStore(selections.backend), base = "a".repeat(64), id = crypto.randomUUID();
  const signal = new AbortController().signal;
  await store.commitStreams(base, { snapshot: workspaceBytesInput(new Uint8Array([9])), delta: workspaceBytesInput(new Uint8Array()) }, signal);
  await selections.retain(id);
  const lease = await selections.retainedWorkspace(id, signal, base);
  if (lease?.snapshot === undefined) throw new Error("Missing source");
  const snapshot = lease.snapshot;
  await selections.release(id);
  await store.commitStreams(base, { snapshot: { bytes: snapshot.bytes, source: sourceSignal => {
    const producer = snapshot.source(sourceSignal);
    return { frames: producer.frames, retire: async () => { await producer.retire(); await lease.retire(); } };
  } }, delta: workspaceBytesInput(new Uint8Array()) }, signal);
  expect(await store.read(base)).toEqual(new Uint8Array([9]));
  // Explicit release remains pending until collection, even if a stale caller's
  // supplied catalogue set still contains this now-unleased identity.
  await selections.collect(new Set([id]));
  expect(await selections.has(id)).toBe(false);
});
