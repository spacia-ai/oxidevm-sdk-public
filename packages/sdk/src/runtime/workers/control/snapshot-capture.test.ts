import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../../errors.js";
import { SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS, type SnapshotStorageRequest, SnapshotStorageClient } from "../snapshot-channel.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import { dirtyCore } from "./core.test-support.js";
import { captureSystemSnapshot } from "./snapshot-capture.js";

const MIB = 1024 * 1024;
const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const opened: { close(): void }[] = [];

function describeRequest(request: SnapshotStorageRequest): string {
  if (request.type === "put-capture-chunk") {
    return `put ${request.area} ${String(request.index)}=${String(request.data[0] ?? 0)}`;
  }
  if (request.type === "seal-capture") return `seal ${request.ramChunks.join(",")}`;
  return request.type;
}

/** Snapshot storage over a real channel that logs each request into `events` and answers it. */
function storage(events: string[], answer: (request: SnapshotStorageRequest) => void = () => undefined) {
  const { port1, port2 } = new MessageChannel();
  const server = serveSnapshotStorage(port1, (request) => {
    events.push(describeRequest(request));
    try {
      answer(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(request.type === "commit-capture" ? SNAPSHOT : undefined);
  });
  const client = new SnapshotStorageClient(port2);
  opened.push({ close: () => { client.close(); void server.close(); } });
  return client;
}

/** Snapshot storage over a real channel that logs each request and never answers those `stalls` picks. */
function stalledStorage(events: string[], stalls: (request: SnapshotStorageRequest) => boolean) {
  const { port1, port2 } = new MessageChannel();
  const server = serveSnapshotStorage(port1, (request) => {
    events.push(describeRequest(request));
    if (stalls(request)) return new Promise<never>(() => undefined);
    return Promise.resolve(request.type === "commit-capture" ? SNAPSHOT : undefined);
  });
  const client = new SnapshotStorageClient(port2);
  opened.push({ close: () => { client.close(); void server.close(); } });
  return client;
}

function range(count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

function hooks(events: string[], precopy: boolean) {
  /** Whether the capture is still copying ahead of its freeze. */
  const run = { precopying: true };
  return {
    run,
    hooks: {
      freeze: () => {
        events.push("freeze");
        run.precopying = false;
        return Promise.resolve(() => {
          events.push("resume");
        });
      },
      agentState: () => undefined,
      precopy,
      now: () => 0,
    },
  };
}

const REQUEST = { memoryBytes: 32 * MIB, vcpus: 1, parentId: undefined, kind: "automatic", label: undefined, appData: undefined } as const;

describe("system snapshot capture", () => {
  afterEach(() => {
    for (const resource of opened.splice(0)) resource.close();
  });

  it("copies dirty RAM while the guest runs and sends only what it dirtied again at the cut", async () => {
    const vm = dirtyCore(range(400));
    const events: string[] = [];
    const { run, hooks: capture } = hooks(events, true);
    const client = storage(events, (request) => {
      if (run.precopying && request.type === "put-capture-chunk" && request.index === 3) vm.write(3);
    });

    const { snapshot } = await captureSystemSnapshot(vm.core, client, REQUEST, capture);

    expect(snapshot).toEqual(SNAPSHOT);
    expect(events).toEqual([
      "open-capture",
      ...range(400).map((index) => `put ram ${String(index)}=1`),
      "freeze",
      "seal 3",
      "resume",
      "put ram 3=2",
      "commit-capture",
    ]);
    // A round clears its chunks' dirty bits before it reads them, so a write in between dirties
    // the chunk again instead of being lost.
    expect(vm.state.calls.slice(0, 2)).toEqual([`clear ${range(400).join(",")}`, "read 0"]);
    expect(vm.state.commits.at(-1)).toEqual([3]);
    expect(vm.state.dirty.size).toBe(0);
    expect(vm.state.marks).toEqual([]);
  }, 30_000);

  it("reports how long the guest was paused, from the freeze to the resume", async () => {
    const vm = dirtyCore([0, 1]);
    const events: string[] = [];
    const { hooks: capture } = hooks(events, false);
    const times = [1_000, 1_137];

    const result = await captureSystemSnapshot(vm.core, storage(events), REQUEST, { ...capture, now: () => times.shift() ?? 0 });

    expect(result).toEqual({ snapshot: SNAPSHOT, pauseMilliseconds: 137 });
  });

  it("stops copying ahead after three rounds when the guest keeps dirtying RAM", async () => {
    const vm = dirtyCore(range(400));
    const events: string[] = [];
    const { run, hooks: capture } = hooks(events, true);
    const client = storage(events, (request) => {
      if (run.precopying && request.type === "put-capture-chunk" && request.index === 0) {
        for (const chunk of range(390)) vm.write(chunk);
      }
    });

    await captureSystemSnapshot(vm.core, client, REQUEST, capture);

    expect(vm.state.commits.map((chunks) => chunks.length)).toEqual([400, 390, 390, 390]);
    expect(events.filter((event) => event.startsWith("seal"))).toEqual([`seal ${range(390).join(",")}`]);
  }, 30_000);

  it("copies a dirty set that fits the cut at the cut instead of ahead of it", async () => {
    for (const [precopy, dirty] of [[false, range(20)], [true, range(384)]] as const) {
      const vm = dirtyCore(dirty);
      const events: string[] = [];
      const client = storage(events);

      await captureSystemSnapshot(vm.core, client, REQUEST, hooks(events, precopy).hooks);

      expect(events).toEqual([
        "open-capture",
        "freeze",
        `seal ${dirty.join(",")}`,
        "resume",
        ...dirty.map((index) => `put ram ${String(index)}=1`),
        "commit-capture",
      ]);
      expect(vm.state.commits).toEqual([[...dirty]]);
    }
  });

  it("writes the cut's chunks as they were at the cut while the resumed guest changes them", async () => {
    const vm = dirtyCore([1, 2]);
    const events: string[] = [];
    const client = storage(events);
    const capture = hooks(events, false).hooks;

    await captureSystemSnapshot(vm.core, client, REQUEST, {
      ...capture,
      freeze: async () => {
        const resume = await capture.freeze();
        return () => {
          resume();
          vm.write(1);
          vm.write(2);
        };
      },
    });

    expect(events.slice(-3)).toEqual(["put ram 1=1", "put ram 2=1", "commit-capture"]);
    // The guest's writes after the cut belong to the next capture.
    expect([...vm.state.dirty].sort((left, right) => left - right)).toEqual([1, 2]);
  });

  it("writes a cut too large to copy into memory before the guest resumes", async () => {
    const dirty = range(400);
    const vm = dirtyCore(dirty);
    const events: string[] = [];

    await captureSystemSnapshot(vm.core, storage(events), REQUEST, hooks(events, false).hooks);

    expect(events.indexOf("resume")).toBe(events.indexOf("commit-capture") - 1);
    expect(events.filter((event) => event.startsWith("put")).length).toBe(400);
  });

  it("marks the cut's chunks dirty again when writing them after the resume fails", async () => {
    const vm = dirtyCore([1, 2]);
    const events: string[] = [];
    const client = storage(events, (request) => {
      if (request.type === "commit-capture") throw new VMError("STORAGE_ERROR", "the disk is full");
    });

    const failure = await captureSystemSnapshot(vm.core, client, REQUEST, hooks(events, false).hooks).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "STORAGE_ERROR" });
    expect(events.slice(-2)).toEqual(["commit-capture", "abort"]);
    expect(vm.state.marks).toEqual([[1, 2]]);
    expect([...vm.state.dirty].sort((left, right) => left - right)).toEqual([1, 2]);
  });

  it("says where a save stopped when storage stops answering, with the guest resumed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const vm = dirtyCore([1, 2]);
      const events: string[] = [];
      const client = stalledStorage(events, (request) => request.type === "put-capture-chunk");

      const failure = captureSystemSnapshot(vm.core, client, REQUEST, hooks(events, false).hooks).catch(
        (error: unknown) => error,
      );
      // The write-out's chunks reach storage after the resume, and storage never answers them.
      await vi.waitFor(() => {
        if (events.filter((event) => event.startsWith("put ram")).length !== 2) throw new Error("not written yet");
      }, { timeout: 5_000, interval: 5 });
      await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS);

      expect(await failure).toMatchObject({
        code: "STORAGE_ERROR",
        detail: { reason: "storage-timeout", request: "put-capture-chunk", phase: "write-out" },
      });
      expect(events).toContain("resume");
      expect(events.at(-1)).toBe("abort");
      expect([...vm.state.dirty].sort((left, right) => left - right)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps several chunk copies in flight instead of waiting for each one", async () => {
    const vm = dirtyCore(range(20));
    const events: string[] = [];
    let outstanding = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const { port1, port2 } = new MessageChannel();
    const server = serveSnapshotStorage(port1, (request) => {
      events.push(describeRequest(request));
      if (request.type !== "put-capture-chunk") {
        return Promise.resolve(request.type === "commit-capture" ? SNAPSHOT : undefined);
      }
      outstanding += 1;
      most = Math.max(most, outstanding);
      // Storage answers a little later, as a busy storage worker does.
      return new Promise<undefined>((resolve) => {
        waiting.push(() => {
          outstanding -= 1;
          resolve(undefined);
        });
        setTimeout(() => waiting.shift()?.(), 5);
      });
    });
    const client = new SnapshotStorageClient(port2);
    opened.push({ close: () => { client.close(); void server.close(); } });

    await captureSystemSnapshot(vm.core, client, REQUEST, hooks(events, true).hooks);

    expect(most).toBe(4);
    expect(events.filter((event) => event.startsWith("put"))).toHaveLength(20);
  });

  it("marks the chunks a pre-copy cleared dirty again when the capture fails", async () => {
    const vm = dirtyCore(range(400));
    const events: string[] = [];
    const client = storage(events, (request) => {
      if (request.type === "seal-capture") throw new VMError("STORAGE_ERROR", "the disk is full");
    });

    const failure = await captureSystemSnapshot(vm.core, client, REQUEST, hooks(events, true).hooks).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "STORAGE_ERROR" });
    // The guest resumes first; the capture is then abandoned and its cleared chunks re-marked.
    expect(events.slice(-4)).toEqual(["freeze", "seal ", "resume", "abort"]);
    expect(vm.state.marks).toEqual([range(400)]);
    expect([...vm.state.dirty].sort((left, right) => left - right)).toEqual(range(400));
  });
});
