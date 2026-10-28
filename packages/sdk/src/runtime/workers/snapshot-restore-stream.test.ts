import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../errors.js";
import { SNAPSHOT_CHANNEL_VERSION } from "./snapshot-channel.js";
import {
  RESTORE_STREAM_WINDOW,
  RestoreStreamReader,
  type RestoreStreamChunk,
  serveRestoreStream,
} from "./snapshot-restore-stream.js";

const channels: MessageChannel[] = [];

function channel(): MessageChannel {
  const created = new MessageChannel();
  channels.push(created);
  return created;
}

function ramChunks(count: number, read: (index: number) => Promise<Uint8Array<ArrayBuffer>>): RestoreStreamChunk[] {
  return Array.from({ length: count }, (_, index) => ({ area: "ram", index, read: () => read(index) }));
}

async function drain(reader: RestoreStreamReader): Promise<[string, number, number][]> {
  const delivered: [string, number, number][] = [];
  for (let chunk = await reader.next(); chunk !== undefined; chunk = await reader.next()) {
    delivered.push([chunk.area, chunk.index, chunk.data[0] ?? -1]);
  }
  return delivered;
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("restore stream", () => {
  it("rejects native frames larger than the one-MiB transfer bound", async () => {
    const {port1,port2}=channel(),reader=new RestoreStreamReader(port2,4);
    port1.postMessage({version:SNAPSHOT_CHANNEL_VERSION,type:"chunk",sequence:0,area:"native-graph",index:0,data:new Uint8Array(1024**2+1)});
    await expect(reader.next()).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  });
  it("enforces a native reader's configured credit window", async () => {
    const {port1,port2}=channel(),reader=new RestoreStreamReader(port2,4);
    for(let index=0;index<5;index++)port1.postMessage({version:SNAPSHOT_CHANNEL_VERSION,type:"chunk",sequence:index,area:"native-graph",index,data:Uint8Array.of(1)});
    await new Promise(resolve=>setTimeout(resolve,20));
    await expect(reader.next()).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  });
  it("shares eight native chunks between graph and payload readers", async () => {
    const started: string[] = [], releases: (() => void)[] = [];
    const graph = channel(), payload = channel(), stop = new AbortController();
    const make = (area: "native-graph" | "native-payloads"): RestoreStreamChunk[] => Array.from({ length: 12 }, (_, index) => ({
      area, index, read: () => new Promise(resolve => { started.push(area); releases.push(() => resolve(Uint8Array.of(index))); }),
    }));
    const jobs = [failure(serveRestoreStream(graph.port1, make("native-graph"), stop.signal)), failure(serveRestoreStream(payload.port1, make("native-payloads"), stop.signal))];
    const readers = [new RestoreStreamReader(graph.port2, 4), new RestoreStreamReader(payload.port2, 4)];
    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(started.filter(area => area === "native-graph")).toHaveLength(4);
    stop.abort(); readers.forEach(reader => reader.cancel()); releases.forEach(release => release());
    expect(await Promise.all(jobs)).toEqual([expect.objectContaining({ code: "ABORTED" }), expect.objectContaining({ code: "ABORTED" })]);
  });
  afterEach(() => {
    for (const created of channels.splice(0)) {
      created.port1.close();
      created.port2.close();
    }
  });

  it("delivers every chunk in order and reads each exactly once", async () => {
    const reads = new Map<number, number>();
    const { port1, port2 } = channel();
    const served = failure(serveRestoreStream(port1, ramChunks(20, (index) => {
      reads.set(index, (reads.get(index) ?? 0) + 1);
      return Promise.resolve(new Uint8Array([index]));
    }), new AbortController().signal));

    const delivered = await drain(new RestoreStreamReader(port2));
    expect(await served).toBeUndefined();

    expect(delivered).toEqual(Array.from({ length: 20 }, (_, index) => ["ram", index, index]));
    expect([...reads.values()]).toEqual(Array.from({ length: 20 }, () => 1));
  });

  it("keeps eight reads in flight and reads one more only as the reader takes a chunk", async () => {
    const started: number[] = [];
    const release = new Map<number, () => void>();
    const { port1, port2 } = channel();
    const served = failure(serveRestoreStream(port1, ramChunks(20, (index) => {
      started.push(index);
      return new Promise((resolve) => release.set(index, () => resolve(new Uint8Array([index]))));
    }), new AbortController().signal));
    const reader = new RestoreStreamReader(port2);

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    release.get(0)?.();
    expect((await reader.next())?.index).toBe(0);
    await vi.waitFor(() => expect(started).toHaveLength(RESTORE_STREAM_WINDOW + 1));

    reader.cancel();
    for (const finish of release.values()) finish();
    expect(await served).toMatchObject({ code: "ABORTED" });
  });

  it("ends with a failed read and delivers no chunk after it", async () => {
    const { port1, port2 } = channel();
    const damaged = new VMError("STORAGE_ERROR", "a snapshot object failed integrity validation", {
      reason: "snapshot-damaged",
    });
    const served = failure(serveRestoreStream(port1, ramChunks(10, (index) => (
      index === 3 ? Promise.reject(damaged) : Promise.resolve(new Uint8Array([index]))
    )), new AbortController().signal));
    const reader = new RestoreStreamReader(port2);
    const delivered: number[] = [];

    const ended = await failure((async () => {
      for (let chunk = await reader.next(); chunk !== undefined; chunk = await reader.next()) delivered.push(chunk.index);
    })());

    expect(delivered).toEqual([0, 1, 2]);
    expect(ended).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "snapshot-damaged" } });
    expect(await served).toBe(damaged);
  });

  it("stops serving when its storage request is aborted", async () => {
    const { port1, port2 } = channel();
    const abort = new AbortController();
    const served = failure(serveRestoreStream(port1, ramChunks(20, (index) => Promise.resolve(new Uint8Array([index]))), abort.signal));
    const reader = new RestoreStreamReader(port2);
    expect((await reader.next())?.index).toBe(0);

    abort.abort();

    expect(await served).toMatchObject({ code: "ABORTED" });
    expect(await failure(drain(reader))).toMatchObject({ code: "ABORTED" });
  });

  it("rejects a chunk out of sequence", async () => {
    const { port1, port2 } = channel();
    const reader = new RestoreStreamReader(port2);

    port1.postMessage({
      version: SNAPSHOT_CHANNEL_VERSION,
      type: "chunk",
      sequence: 1,
      area: "ram",
      index: 0,
      data: new Uint8Array(1),
    });

    expect(await failure(reader.next())).toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});
