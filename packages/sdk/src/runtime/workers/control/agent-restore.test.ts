import { expect, it, vi } from "vitest";
import { AgentRestore } from "./agent-restore.js";
import type { RestoreStatus, WorkspaceRestore } from "../../protocol/workspace-restore.js";

/** A guest whose apply has already ended. */
const applied = (): Promise<RestoreStatus> => Promise.resolve({ state: "done", applied: 0, total: 0 });

it("sends bounded authenticated chunks and waits for producer retirement before commit", async () => {
  const operations: WorkspaceRestore[] = [];
  const retirement = Promise.withResolvers<undefined>();
  const retire = vi.fn(() => retirement.promise);
  const fail = vi.fn();
  const restore = new AgentRestore(() => ({ transfer: 11, ready: Promise.resolve("receive" as const), status: applied,
    send: (_id, operation) => { operations.push(operation); return Promise.resolve(); } }), fail);
  const bytes = new Uint8Array(131_077).fill(42);
  const done = restore.apply(9, "snapshot", { bytes: bytes.length,
    source: () => ({ frames: (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 65_536) yield await Promise.resolve(bytes.slice(offset, offset + 65_536));
    })(), retire }) });
  await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
  expect(operations.map(operation => operation.kind)).toEqual(["chunk", "chunk", "chunk"]);
  let offset = 0;
  for (const operation of operations) {
    if (operation.kind !== "chunk") throw new Error("chunk expected");
    expect(operation.offset).toBe(offset);
    expect(operation.data.length).toBeLessThanOrEqual(65_536);
    expect(operation.sha256).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(operation.data))));
    offset += operation.data.length;
  }
  retirement.resolve(undefined);
  await done;
  expect(operations.at(-1)).toEqual({ kind: "commit", transfer: 11 });
  expect(operations.filter(operation => operation.kind === "commit")).toHaveLength(1);
  expect(fail).not.toHaveBeenCalled();
});

it("cancels a blocked source, retires both owners, and admits a new transfer afterward", async () => {
  const operations: WorkspaceRestore[] = [];
  const started = Promise.withResolvers<undefined>();
  const restore = new AgentRestore(() => ({ transfer: 12, ready: Promise.resolve("receive" as const), status: applied,
    send: (_id, operation) => { operations.push(operation); return Promise.resolve(); } }), error => { throw error; });
  const retire = vi.fn(async () => {});
  const done = restore.apply(10, "delta", { bytes: 12, source: signal => ({ retire,
    frames: (async function* () {
      started.resolve(undefined);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield new Uint8Array(12);
    })(),
  }) });
  const rejected = expect(done).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  restore.cancel(10);
  await rejected;
  expect(operations).toEqual([{ kind: "abort", transfer: 12 }]);
  expect(retire).toHaveBeenCalledTimes(1);
  await restore.apply(11, "delta", { bytes: 12, source: () => ({ retire: async () => {}, frames: (async function* () { yield await Promise.resolve(new Uint8Array(12)); })() }) });
});

it.each(["commit", "retirement", "abort"] as const)("fences uncertain %s outcomes", async failure => {
  const failed = vi.fn((error: unknown) => new Error(`fenced: ${String(error)}`));
  const restore = new AgentRestore(() => ({ transfer: 13, ready: Promise.resolve("receive" as const), status: applied,
    send: (_id, operation) => operation.kind === failure ? Promise.reject(new Error("lost guest reply")) : Promise.resolve(),
  }), failed);
  await expect(restore.apply(12, "snapshot", { bytes: 12, source: () => ({
    retire: () => failure === "retirement" ? Promise.reject(new Error("owner loss")) : Promise.resolve(),
    frames: (async function* () { if (failure === "abort") throw new Error("read error"); yield await Promise.resolve(new Uint8Array(12)); })(),
  }) })).rejects.toThrow("fenced");
  expect(failed).toHaveBeenCalledTimes(1);
});

it.each(["short", "oversized", "view"] as const)("retires malformed %s producers without publishing", async kind => {
  const operations: WorkspaceRestore[] = [];
  const failed = vi.fn();
  const retire = vi.fn(async () => {});
  const restore = new AgentRestore(() => ({ transfer: 14, ready: Promise.resolve("receive" as const), status: applied, send: (_id, operation) => {
    operations.push(operation);
    return Promise.resolve();
  } }), failed);
  const frame = kind === "short" ? new Uint8Array(11) : kind === "oversized" ? new Uint8Array(65_537) : new Uint8Array(14).subarray(1, 13);
  await expect(restore.apply(13, "snapshot", { bytes: 12,
    source: () => ({ retire, frames: (async function* () { yield await Promise.resolve(frame); })() }) })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(operations.at(-1)?.kind).toBe("abort");
  expect(operations.some(operation => operation.kind === "commit")).toBe(false);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

it("retires a blocked producer after transport loss without sending cleanup to a replacement guest", async () => {
  const reading = Promise.withResolvers<undefined>();
  const send = vi.fn(async () => {});
  const failed = vi.fn(() => new Error("fenced after transport loss"));
  const retire = vi.fn(async () => {});
  const restore = new AgentRestore(() => ({ transfer: 15, ready: Promise.resolve("receive" as const), status: applied, send }), failed);
  const done = restore.apply(14, "snapshot", { bytes: 12, source: signal => ({ retire,
    frames: (async function* () {
      reading.resolve(undefined);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield new Uint8Array(12);
    })(),
  }) });
  const rejected = expect(done).rejects.toThrow("fenced after transport loss");
  await reading.promise;
  restore.stop(new Error("guest stopped"));
  await rejected;
  expect(send).not.toHaveBeenCalled();
  expect(retire).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledTimes(1);
});

it("polls the apply's status after commit until the guest reports it done", async () => {
  const statuses: RestoreStatus[] = [{ state: "applying", applied: 0, total: 3 }, { state: "applying", applied: 2, total: 3 }, { state: "done", applied: 3, total: 3 }];
  const polls: number[] = [];
  const restore = new AgentRestore(() => ({ transfer: 21, ready: Promise.resolve("receive" as const),
    send: () => Promise.resolve(),
    status: id => { polls.push(id); const next = statuses.shift(); if (next === undefined) throw new Error("polled after done"); return Promise.resolve(next); },
  }), vi.fn(), { pollMs: 1, stallMs: 1_000 });
  await restore.apply(20, "snapshot", { bytes: 12, source: () => ({ retire: () => Promise.resolve(), frames: (async function* () { yield await Promise.resolve(new Uint8Array(12)); })() }) });
  expect(polls).toEqual([20, 20, 20]);
});

it("fences a failed apply with the guest's error and fails a stalled one by progress, not time alone", async () => {
  const failed = vi.fn((error: unknown) => (error instanceof Error ? error : new Error("fenced")));
  const failing = new AgentRestore(() => ({ transfer: 22, ready: Promise.resolve("receive" as const), send: () => Promise.resolve(),
    status: () => Promise.resolve({ state: "failed" as const, applied: 4, total: 9, error: "EACCES" }) }), failed, { pollMs: 1, stallMs: 1_000 });
  const source = () => ({ retire: () => Promise.resolve(), frames: (async function* () { yield await Promise.resolve(new Uint8Array(12)); })() });
  const failure = failing.apply(21, "snapshot", { bytes: 12, source });
  await expect(failure).rejects.toMatchObject({ code: "GUEST_CRASH" });
  await expect(failure).rejects.toThrow(/EACCES/u);
  expect(failed).toHaveBeenCalledTimes(1);
  let polls = 0;
  const stalled = new AgentRestore(() => ({ transfer: 23, ready: Promise.resolve("receive" as const), send: () => Promise.resolve(),
    status: () => { polls += 1; return Promise.resolve({ state: "applying" as const, applied: 1, total: 9 }); } }), failed, { pollMs: 1, stallMs: 20 });
  const stall = stalled.apply(22, "snapshot", { bytes: 12, source });
  await expect(stall).rejects.toMatchObject({ code: "GUEST_CRASH" });
  await expect(stall).rejects.toThrow(/stalled/u);
  expect(polls).toBeGreaterThan(1);
});

it("keeps up to four chunk sends in flight in offset order so transport and guest work overlap", async () => {
  const pending: { operation: WorkspaceRestore; resolve: () => void }[] = [];
  const settled: number[] = [];
  const restore = new AgentRestore(() => ({ transfer: 31, ready: Promise.resolve("receive" as const), status: applied,
    send: (_id, operation) => {
      if (operation.kind !== "chunk") return Promise.resolve();
      return new Promise<void>(resolve => { pending.push({ operation, resolve: () => { settled.push(operation.offset); resolve(); } }); });
    } }), vi.fn(), { pollMs: 1, stallMs: 1_000 });
  const bytes = new Uint8Array(65_536 * 8).fill(7);
  const done = restore.apply(30, "snapshot", { bytes: bytes.length, source: () => ({ retire: () => Promise.resolve(),
    frames: (async function* () { for (let offset = 0; offset < bytes.length; offset += 65_536) yield await Promise.resolve(bytes.slice(offset, offset + 65_536)); })() }) });
  await vi.waitFor(() => { expect(pending).toHaveLength(4); });
  expect(pending.map(entry => entry.operation.kind === "chunk" ? entry.operation.offset : -1)).toEqual([0, 65_536, 131_072, 196_608]);
  pending.shift()?.resolve();
  await vi.waitFor(() => { expect(pending).toHaveLength(4); });
  const newest = pending.at(-1)?.operation;
  expect(newest?.kind === "chunk" ? newest.offset : -1).toBe(262_144);
  for (;;) {
    await vi.waitFor(() => { expect(pending.length > 0 || settled.length === 8).toBe(true); });
    if (settled.length === 8) break;
    pending.shift()?.resolve();
  }
  await done;
  expect(settled).toEqual([0, 65_536, 131_072, 196_608, 262_144, 327_680, 393_216, 458_752]);
});
