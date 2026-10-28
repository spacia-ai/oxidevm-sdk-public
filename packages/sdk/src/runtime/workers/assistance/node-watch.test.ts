import { expect, it, vi } from "vitest";
import type { AssistanceResult } from "../../protocol/assistance-reply.ts";
import { createAsyncContext } from "./async-context.ts";
import { createNodeWatchers } from "./node-watch.ts";

function fixture() {
  const context = createAsyncContext();
  const pending: PromiseWithResolvers<AssistanceResult>[] = [];
  const removed: number[] = []; const failures: unknown[] = []; let references = 0;
  const watchers = createNodeWatchers({
    callSync(operation) { if (operation.kind === "watch-add") return { kind: "watch-opened", watch: 1 }; if (operation.kind === "watch-remove") { removed.push(operation.watch); return { kind: "unit" }; } throw Error("operation"); },
    call(operation, referenced) { expect(operation.kind).toBe("watch-read"); expect(referenced).toBe(false); const reply = Promise.withResolvers<AssistanceResult>(); pending.push(reply); return reply.promise; },
    retain() { references++; return () => { references--; }; }, fail(error) { failures.push(error); },
  }, context, { enqueue: callback => { queueMicrotask(callback); } });
  return { context, watchers, pending, removed, failures, references: () => references };
}

it("shares Linux watches while preserving creation context and reference lifetimes", async () => {
  const f = fixture(); const store = new f.context.AsyncLocalStorage<string>();
  const first = store.run("creation", () => f.watchers.watch("/workspace/app"));
  const second = f.watchers.watch("/workspace/app", { encoding: "buffer", persistent: false });
  const seen: unknown[] = [];
  store.run("listener", () => first.on("change", (kind, name) => seen.push([kind, name, store.getStore()])));
  second.on("change", (kind, name) => seen.push([kind, name]));
  expect(f.references()).toBe(1);
  expect(first.unref()).toBe(first); expect(f.references()).toBe(0);
  expect(first.ref()).toBe(first); expect(f.references()).toBe(1);
  f.pending[0]?.resolve({ kind: "watch-events", events: [{ sequence: 1n, watch: 1, change: "change", mask: 2, cookie: 0, name: new Uint8Array([97]) }] });
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[0]).toEqual(["change", "a", "creation"]);
  first.close(); expect(f.references()).toBe(0); expect(f.removed).toEqual([1]);
  second.close(); second.close(); expect(f.removed).toEqual([1, 1]);
  f.watchers.dispose();
});

it("retired inodes retain Node watcher lifetime and do not silently resubscribe", async () => {
  const f = fixture(); const watcher = f.watchers.watch("/workspace/app"); const seen: unknown[] = [];
  watcher.on("change", (...args) => seen.push(args)); watcher.on("close", () => seen.push("close"));
  f.pending[0]?.resolve({ kind: "watch-events", events: [{ sequence: 1n, watch: 1, change: "retired", mask: 0x8000, cookie: 0, name: null }] });
  await vi.waitFor(() => expect(seen).toEqual([["rename", "app"]]));
  expect(f.references()).toBe(1); expect(f.pending).toHaveLength(1);
  watcher.close(); await vi.waitFor(() => expect(seen).toContain("close"));
  expect(f.removed).toEqual([]); expect(f.references()).toBe(0);
});

it("overflow fails the affected process even when an application handles watcher errors", async () => {
  const f = fixture(); const watcher = f.watchers.watch("/workspace/app"); watcher.on("error", () => {});
  f.pending[0]?.resolve({ kind: "watch-events", events: [{ sequence: 1n, watch: null, change: "overflow", mask: 0x4000, cookie: 0, name: null }] });
  await vi.waitFor(() => expect(f.failures).toHaveLength(1));
  expect(f.failures[0]).toMatchObject({ code: "GUEST_CRASH" });
  expect(f.references()).toBe(0);
});

it("abort and duplicate close release exactly once and suppress queued data", async () => {
  const f = fixture(); const controller = new AbortController();
  const watcher = f.watchers.watch("/workspace/app", { signal: controller.signal });
  const changes = vi.fn(); const close = vi.fn(); watcher.on("change", changes); watcher.on("close", close);
  controller.abort(); watcher.close();
  f.pending[0]?.resolve({ kind: "watch-events", events: [{ sequence: 1n, watch: 1, change: "rename", mask: 0x100, cookie: 0, name: new Uint8Array([97]) }] });
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(changes).not.toHaveBeenCalled(); expect(f.removed).toEqual([1]); expect(f.references()).toBe(0); expect(f.failures).toEqual([]);
  const aborted = new AbortController(); aborted.abort();
  const early = f.watchers.watch("/workspace/missing", { signal: aborted.signal });
  early.on("close", close);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(f.pending).toHaveLength(1); expect(f.removed).toEqual([1]); expect(f.references()).toBe(0);
  f.watchers.dispose();
});

it("lost sequences fail explicitly and unsupported recursive watching is not a no-op", async () => {
  const f = fixture();
  expect(() => f.watchers.watch("/workspace", { recursive: true })).toThrow("fs.watch recursive");
  expect(f.pending).toHaveLength(0);
  f.watchers.watch("/workspace");
  f.pending[0]?.resolve({ kind: "watch-events", events: [{ sequence: 2n, watch: 1, change: "change", mask: 2, cookie: 0, name: null }] });
  await vi.waitFor(() => expect(f.failures).toHaveLength(1));
  expect(f.failures[0]).toMatchObject({ code: "PROTOCOL_ERROR" }); expect(f.references()).toBe(0);
});
