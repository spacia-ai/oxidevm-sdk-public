import { expect, it, vi } from "vitest";
import { createUserspaceWorkspaceCommit, flushUserspaceFiles } from "./userspace-workspace-commit.js";

it("serializes concurrent explicit barriers with scheduled publications", async () => {
  const release = Promise.withResolvers<undefined>();
  let concurrent = 0, maximum = 0, calls = 0;
  const owner = createUserspaceWorkspaceCommit(async () => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    if (++calls === 1) await release.promise;
    concurrent--;
  }, () => {});
  const first = owner.flush(), second = owner.flush();
  await Promise.resolve(); await Promise.resolve();
  release.resolve(undefined);
  await Promise.all([first, second]);
  expect(maximum).toBe(1);
  expect(calls).toBe(2);
});

it("drains root publication during disposal even when workspace persistence fails", async () => {
  vi.useFakeTimers();
  const release = Promise.withResolvers<undefined>();
  try {
    const failure = new Error("workspace quota");
    const workspace = createUserspaceWorkspaceCommit(() => Promise.reject(failure), () => {});
    let rootFinished = false;
    const root = createUserspaceWorkspaceCommit(async () => { await release.promise; rootFinished = true; }, () => {});
    void workspace.schedule(); void root.schedule();
    const flush = flushUserspaceFiles(workspace, root);
    const failed = expect(flush).rejects.toBe(failure);
    await Promise.resolve();
    expect(rootFinished).toBe(false);
    release.resolve(undefined);
    await failed;
    expect(rootFinished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { release.resolve(undefined); vi.useRealTimers(); }
});

it("coalesces writes for 250 ms and acknowledges only their durable commit", async () => {
  vi.useFakeTimers();
  try {
    let release: () => void = () => undefined;
    const durable = new Promise<void>(resolve => { release = resolve; });
    const persist = vi.fn(() => durable), failed = vi.fn();
    const owner = createUserspaceWorkspaceCommit(persist, failed);
    let acknowledged = false; const write = owner.schedule().then(() => { acknowledged = true; });
    await vi.advanceTimersByTimeAsync(200); expect(owner.schedule()).toBe(owner.schedule());
    await vi.advanceTimersByTimeAsync(50); expect(persist).toHaveBeenCalledTimes(1); expect(acknowledged).toBe(false);
    release(); await write; expect(acknowledged).toBe(true); expect(failed).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it("flushes pending writes during disposal and propagates persistence failures", async () => {
  vi.useFakeTimers();
  try {
    const failure = new Error("storage full"), failed = vi.fn();
    let broken = true;
    const owner = createUserspaceWorkspaceCommit(() => broken ? Promise.reject(failure) : Promise.resolve(), failed);
    const write = owner.schedule(); const rejection = expect(write).rejects.toBe(failure);
    await expect(owner.flush()).rejects.toBe(failure); await rejection; expect(failed).toHaveBeenCalledWith(failure);
    broken = false; void owner.schedule(); await owner.flush(); owner.reset(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("a write arriving during an in-flight snapshot waits for the following snapshot", async () => {
  vi.useFakeTimers();
  try {
    let revision = 1, durable = 0, calls = 0, release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = createUserspaceWorkspaceCommit(async () => { const captured = revision; if (++calls === 1) await gate; durable = captured; }, () => undefined);
    const first = owner.schedule(); await vi.advanceTimersByTimeAsync(250); revision = 2;
    let secondAcknowledged = false; const second = owner.schedule().then(() => { secondAcknowledged = true; });
    release(); await first; expect(durable).toBe(1); expect(secondAcknowledged).toBe(false);
    await vi.advanceTimersByTimeAsync(250); await second; expect(durable).toBe(2);
  } finally { vi.useRealTimers(); }
});

it("keeps one coalesced pending publication while a commit is blocked", async () => {
  vi.useFakeTimers();
  const release = Promise.withResolvers<undefined>();
  try {
    const persist = vi.fn(async () => { if (persist.mock.calls.length === 1) await release.promise; });
    const owner = createUserspaceWorkspaceCommit(persist, () => {});
    const first = owner.flush();
    await Promise.resolve();
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 8; index++) {
      writes.push(owner.schedule());
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(new Set(writes).size).toBe(1);
    release.resolve(undefined);
    await Promise.all([first, ...writes]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { release.resolve(undefined); vi.useRealTimers(); }
});
