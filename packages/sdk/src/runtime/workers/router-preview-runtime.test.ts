import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouterConnection, RouterOpenResult, RouterRead } from "./netstack/connections.js";
import type { PreviewRuntimeCompletion } from "./preview-runtime-channel.js";
import { ROUTER_PROCESS, ROUTER_OPEN_RETRY_MS, RouterPreviewRuntime, type RouterLink } from "./router-preview-runtime.js";

/** A router connection whose reads and writes are scripted, recording every call. */
class FakeConnection implements RouterConnection {
  readonly calls: unknown[][] = [];
  readonly reads: RouterRead[] = [];
  accept = Number.POSITIVE_INFINITY;
  throwOnWrite = false;
  constructor(readonly id: number) {}

  write(bytes: Uint8Array): number {
    this.calls.push(["write", bytes.byteLength]);
    if (this.throwOnWrite) throw new Error("router trapped");
    return Math.min(bytes.byteLength, this.accept);
  }

  read(maxBytes: number, waitMs: number): Promise<RouterRead> {
    this.calls.push(["read", maxBytes, waitMs]);
    return Promise.resolve(this.reads.shift() ?? { kind: "blocked" });
  }

  wait(interest: "read" | "write"): Promise<void> {
    this.calls.push(["wait", interest]);
    return Promise.resolve();
  }

  close(): void {
    this.calls.push(["close"]);
  }
}

function link(...results: RouterOpenResult[]): RouterLink & { readonly opened: number[] } {
  const opened: number[] = [];
  return {
    opened,
    open: (port: number) => {
      opened.push(port);
      const result = results.shift();
      if (result === undefined) throw new Error("no open was scripted");
      return Promise.resolve(result);
    },
  };
}

async function openThrough(runtime: RouterPreviewRuntime): Promise<{ readonly generation: bigint; readonly process: number; readonly connection: number }> {
  const opened = await runtime.request({ kind: "open", port: 3000, process: null });
  if (opened.kind !== "opened") throw new Error(`open answered ${opened.kind}`);
  return { generation: opened.generation, process: opened.process, connection: opened.connection };
}

describe("router preview transport", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens through the router and names the connection", async () => {
    const connection = new FakeConnection(7);
    const router = link({ kind: "connected", connection });
    const runtime = new RouterPreviewRuntime(() => router);
    expect(runtime.available).toBe(true);
    await expect(runtime.request({ kind: "open", port: 3000, process: null }))
      .resolves.toEqual({ kind: "opened", generation: 1n, process: ROUTER_PROCESS, connection: 7 });
    expect(router.opened).toEqual([3000]);
  });

  it("answers refused and busy no sooner than 25 ms after the open began", async () => {
    const router = link({ kind: "refused" }, { kind: "busy" });
    const runtime = new RouterPreviewRuntime(() => router);
    const settled: PreviewRuntimeCompletion[] = [];
    void runtime.request({ kind: "open", port: 3000, process: null }).then((done) => { settled.push(done); });
    void runtime.request({ kind: "open", port: 3000, process: null }).then((done) => { settled.push(done); });
    await vi.advanceTimersByTimeAsync(ROUTER_OPEN_RETRY_MS - 1);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([{ kind: "error", code: "listener" }, { kind: "error", code: "staging" }]);
  });

  it("answers a timed-out open as a missing listener at once", async () => {
    const router = link({ kind: "timed-out" });
    const runtime = new RouterPreviewRuntime(() => router);
    await expect(runtime.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "listener" });
  });

  it("reads without polling and maps each router answer", async () => {
    const connection = new FakeConnection(7);
    connection.reads.push({ kind: "data", bytes: Uint8Array.of(1, 2) }, { kind: "blocked" }, { kind: "eof" }, { kind: "reset" });
    const router = link({ kind: "connected", connection });
    const runtime = new RouterPreviewRuntime(() => router);
    const target = await openThrough(runtime);
    const read = () => runtime.request({ kind: "read", ...target, maxBytes: 65_536 });
    await expect(read()).resolves.toEqual({ kind: "read", bytes: Uint8Array.of(1, 2) });
    await expect(read()).resolves.toEqual({ kind: "blocked" });
    await expect(read()).resolves.toEqual({ kind: "eof" });
    await expect(read()).resolves.toEqual({ kind: "error", code: "read" });
    expect(connection.calls[0]).toEqual(["read", 65_536, 0]);
    await expect(runtime.request({ kind: "write", ...target, bytes: Uint8Array.of(9) })).resolves.toEqual({ kind: "error", code: "write" });
  });

  it("writes report progress, back-pressure and a failure", async () => {
    const connection = new FakeConnection(7);
    const router = link({ kind: "connected", connection });
    const runtime = new RouterPreviewRuntime(() => router);
    const target = await openThrough(runtime);
    const write = () => runtime.request({ kind: "write", ...target, bytes: Uint8Array.of(1, 2, 3) });
    connection.accept = 2;
    await expect(write()).resolves.toEqual({ kind: "written", bytes: 2 });
    connection.accept = 0;
    await expect(write()).resolves.toEqual({ kind: "blocked" });
    connection.throwOnWrite = true;
    await expect(write()).resolves.toEqual({ kind: "error", code: "write" });
  });

  it("answers process for a closed, foreign or replaced-link connection", async () => {
    const first = new FakeConnection(7);
    let current: RouterLink = link({ kind: "connected", connection: first }, { kind: "connected", connection: new FakeConnection(8) });
    const runtime = new RouterPreviewRuntime(() => current);
    const target = await openThrough(runtime);
    await expect(runtime.request({ kind: "read", generation: 1n, process: 2, connection: target.connection, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    await expect(runtime.request({ kind: "read", ...target, connection: 99, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    await expect(runtime.request({ kind: "close", ...target })).resolves.toEqual({ kind: "closed" });
    expect(first.calls.at(-1)).toEqual(["close"]);
    await expect(runtime.request({ kind: "read", ...target, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    const second = await openThrough(runtime);
    current = link();
    await expect(runtime.request({ kind: "read", ...second, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
  });

  it("answers channel when the open is aborted or no link exists, and never throws", async () => {
    const router = link({ kind: "refused" });
    const runtime = new RouterPreviewRuntime(() => router);
    const stop = new AbortController();
    const aborted = runtime.request({ kind: "open", port: 3000, process: null }, stop.signal);
    stop.abort();
    await vi.advanceTimersByTimeAsync(ROUTER_OPEN_RETRY_MS);
    await expect(aborted).resolves.toEqual({ kind: "error", code: "channel" });
    const absent = new RouterPreviewRuntime(() => undefined);
    expect(absent.available).toBe(false);
    await expect(absent.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "channel" });
    const throwing = new RouterPreviewRuntime(() => ({ open: () => Promise.reject(new Error("router trapped")) }));
    await expect(throwing.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "channel" });
  });

  it("rejects a stale handle when a new link reuses its connection ID", async () => {
    let current = link({ kind: "connected", connection: new FakeConnection(7) });
    const runtime = new RouterPreviewRuntime(() => current);
    const stale = await openThrough(runtime);
    const replacement = new FakeConnection(7);
    current = link({ kind: "connected", connection: replacement });
    const live = await openThrough(runtime);
    expect(live.generation).not.toBe(stale.generation);
    await expect(runtime.request({ kind: "close", ...stale })).resolves.toEqual({ kind: "error", code: "process" });
    await expect(runtime.request({ kind: "write", ...live, bytes: Uint8Array.of(1) })).resolves.toEqual({ kind: "written", bytes: 1 });
    expect(replacement.calls).toEqual([["write", 1]]);
  });
});
