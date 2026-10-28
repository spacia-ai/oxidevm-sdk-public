import { expect, it, vi } from "vitest";
import { NativeSnapshotFiles } from "./snapshot-userspace-files.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { WorkspaceStore } from "./workspace-store.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";

const BASE = "a".repeat(64);
const ROOT = "b".repeat(64);
const SAVED = "11111111-2222-4333-8444-555555555555";
const BEFORE = "22222222-2222-4333-8444-555555555555";
const EMPTY = "33333333-2222-4333-8444-555555555555";
const signal = () => new AbortController().signal;

async function setup(objects?: SnapshotObjects) {
  const selections = new WorkspaceSelections(opfsWorkspaceStoreBackend(new MemoryDirectory()));
  objects ??= await SnapshotObjects.open(new MemoryDirectory());
  const files = new NativeSnapshotFiles(selections, objects);
  const write = async (value: number) => {
    await new WorkspaceStore(selections.backend).commitStreams(BASE, {
      snapshot: workspaceBytesInput(new Uint8Array([value])), delta: workspaceBytesInput(new Uint8Array()),
      dependencies: { inputsSha256: ROOT, tree: workspaceBytesInput(new Uint8Array([value + 2])) },
    }, signal());
    await (await openUserspaceRootStore(selections.backend, ROOT)).commitStreams(ROOT, {
      snapshot: workspaceBytesInput(new Uint8Array([value + 1])), delta: workspaceBytesInput(new Uint8Array()),
    }, signal());
  };
  const read = async () => [await new WorkspaceStore(selections.backend).read(BASE),
    await (await openUserspaceRootStore(selections.backend, ROOT)).read(ROOT)];
  return { files, selections, objects, write, read };
}

it("restores portable files together and retains replaced files for restart instead", async () => {
  const source = await setup();
  await source.write(1);
  const durable = await source.files.capture(SAVED, BASE, ROOT, signal());
  const destination = await setup(source.objects);
  await destination.write(3);
  await destination.selections.retain(BEFORE, ROOT);
  const staged = await destination.files.prepare(SAVED, ROOT, durable, signal());
  expect(await destination.read()).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
  await staged.commit(signal());
  expect(await destination.read()).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  const lease = await new WorkspaceStore(destination.selections.backend).openRead(BASE, signal());
  expect(lease?.dependencies?.inputsSha256).toBe(ROOT);
  await lease?.retire();
  await destination.selections.publish(BEFORE, signal());
  expect(await destination.read()).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});

it("restoring an empty durable generation removes newer files from later restarts", async () => {
  const source = await setup();
  const durable = await source.files.capture(EMPTY, BASE, ROOT, signal());
  const destination = await setup(source.objects);
  await destination.write(7);
  const staged = await destination.files.prepare(EMPTY, ROOT, durable, signal());
  await staged.commit(signal());
  expect(await destination.read()).toEqual([undefined, undefined]);
});

it("reuses verified durable chunks for equal retained file generations without copying streams", async () => {
  const source = await setup(); await source.write(1);
  const durable = await source.files.capture(SAVED, BASE, ROOT, signal());
  if (durable === undefined) throw new Error("Missing durable files");
  await source.write(1);
  const puts = vi.spyOn(source.objects, "put");
  expect(await source.files.capture(BEFORE, BASE, ROOT, signal(), { id: SAVED, durable })).toEqual(durable);
  expect(puts).not.toHaveBeenCalled();
  await source.selections.publish(BEFORE, signal());
  expect(await source.read()).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
});

it("copies changed durable streams while retaining each unchanged tree", async () => {
  const source = await setup(); await source.write(1);
  const durable = await source.files.capture(SAVED, BASE, ROOT, signal());
  if (durable === undefined) throw new Error("Missing durable files");
  await new WorkspaceStore(source.selections.backend).commitStreams(BASE, {
    snapshot: workspaceBytesInput(new Uint8Array([9])), delta: workspaceBytesInput(new Uint8Array()),
  }, signal());
  const puts = vi.spyOn(source.objects, "put");
  const next = await source.files.capture(BEFORE, BASE, ROOT, signal(), { id: SAVED, durable });
  expect(next?.root).toEqual(durable.root);
  expect(next?.workspace).not.toEqual(durable.workspace);
  expect(puts.mock.calls.map(([bytes]) => bytes)).toEqual([new Uint8Array([9]), new Uint8Array([3])]);
  const destination = await setup(source.objects), staged = await destination.files.prepare(BEFORE, ROOT, next, signal());
  await staged.commit(signal());
  expect(await destination.read()).toEqual([new Uint8Array([9]), new Uint8Array([2])]);
});

it("cancelled staging and missing checkpoint bytes preserve the current file pair", async () => {
  const source = await setup();
  await source.write(1);
  const durable = await source.files.capture(SAVED, BASE, ROOT, signal());
  const destination = await setup(source.objects);
  await destination.write(3);
  const staged = await destination.files.prepare(SAVED, ROOT, durable, signal());
  await expect(staged.commit(AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  await staged.abort();
  expect(await destination.read()).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
  const missing = durable?.workspace?.snapshot.chunks[0];
  if (missing === undefined) throw new Error("snapshot bytes missing");
  await source.objects.remove(missing.sha256);
  await expect(destination.files.prepare(SAVED, ROOT, durable, signal())).rejects.toThrow();
  expect(await destination.read()).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});
