import { afterEach, describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { SnapshotStorageClient } from "../snapshot-channel.js";
import { serveRestoreStream } from "../snapshot-restore-stream.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import type { RestoredSnapshot,SnapshotEventRecord } from "../../protocol.js";
import { type AgentResumeState, encodeAgentResumeState } from "./agent-resume-state.js";
import { dirtyCore, recordingCore } from "./core.test-support.js";
import { type SnapshotMachine, SnapshotSession } from "./snapshot-session.js";

const MIB = 1024 * 1024;
const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const opened: { close(): void }[] = [];

interface StorageScript {
  /** The RAM chunks the snapshot holds, streamed in this order. */
  readonly ram: readonly number[];
  readonly read: (index: number) => Promise<Uint8Array<ArrayBuffer>>;
  /** Fails the stream request itself, before any chunk. */
  readonly streamFailure?: VMError;
  /** The OXHA record stored with the snapshot. */
  readonly agentState?: Uint8Array;
  /** The page data saved with the snapshot. */
  readonly appData?: Uint8Array;
  /** The managed disk the restore replaces holds newer files. */
  readonly newerFiles?: boolean;
  readonly systemImage?:RestoredSnapshot["systemImage"];
}

/** Snapshot storage over a real channel, serving one prepared restore as `script` says. */
function storage(script: StorageScript) {
  const requests: string[] = [];
  const { port1, port2 } = new MessageChannel();
  const server = serveSnapshotStorage(port1, (request, signal) => {
    requests.push(request.type);
    if (request.type === "prepare-restore") {
      return Promise.resolve({
        snapshot: SNAPSHOT,
        capturedAtUnixMs: 1_790_000_000_000,
        newerFiles: script.newerFiles ?? false,
        ...(script.systemImage===undefined?{}:{systemImage:script.systemImage}),
        machineRecord: new Uint8Array(32),
        memoryBytes: 16 * MIB,
        ramChunks: script.ram,
        disk: { mode: "none", bytes: 0, baseChunks: [], overlayChunks: [] },
        ...(script.agentState === undefined ? {} : { agentState: script.agentState }),
        ...(script.appData === undefined ? {} : { appData: script.appData }),
      });
    }
    if (request.type === "stream-restore") {
      if (script.streamFailure !== undefined) return Promise.reject(script.streamFailure);
      return serveRestoreStream(request.port, script.ram.map((index) => ({
        area: "ram" as const,
        index,
        read: () => script.read(index),
      })), signal);
    }
    if (request.type === "commit-restore-disk" || request.type === "complete-restore" || request.type === "abort") {
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected ${request.type}`));
  });
  const client = new SnapshotStorageClient(port2);
  opened.push({ close: () => { client.close(); void server.close(); } });
  return { client, requests };
}

function session(client: SnapshotStorageClient) {
  const { core, calls } = recordingCore(0, 32);
  const events: string[] = [];
  const agents: (AgentResumeState | undefined)[] = [];
  const disks: string[] = [];
  const notices: SnapshotEventRecord[] = [];
  let clock = 0;
  const machine: SnapshotMachine = {
    core: () => core,
    storage: () => client,
    requireBooted: () => undefined,
    memoryBytes: () => 16 * MIB,
    shape: () => ({ memoryMiB: 16, vcpus: 1, profile: 2 }),
    freeze: () => Promise.resolve(() => undefined),
    precopy: () => false,
    stop: () => {
      events.push("stop");
      return Promise.resolve();
    },
    restarted: (_memoryBytes, agent, disk) => {
      events.push("restarted");
      agents.push(agent);
      disks.push(disk);
    },
    agentState: () => undefined,
    syncFilesystems: () => Promise.resolve(),
    notify: (event) => notices.push(event),
    // Each reading of the clock is 40 ms after the last.
    now: () => (clock += 40),
    lost: () => events.push("lost"),
  };
  const restores = () => calls.filter((call) => call.name.startsWith("oxidevm_system_restore_"));
  return { snapshots: new SnapshotSession(machine), restores, events, agents, disks, notices };
}

describe("snapshot session restore", () => {
  afterEach(() => {
    for (const resource of opened.splice(0)) resource.close();
  });

  it("cancels a prepared restore before the first destructive core operation", async () => {
    let cancelled = false;
    const { client } = storage({ ram: [0], read: () => {
      cancelled = true;
      return Promise.resolve(new Uint8Array(MIB));
    } });
    const { snapshots, restores, events } = session(client);
    await expect(snapshots.restore(SNAPSHOT, () => {
      if (cancelled) throw new VMError("ABORTED", "Restore cancelled");
    })).rejects.toMatchObject({ code: "ABORTED" });
    expect(restores().map(call => call.name)).not.toContain("oxidevm_system_restore_begin");
    expect(events).not.toContain("lost");
    expect(events).not.toContain("restarted");
  });

  it("restores streamed RAM chunks into the core, then finishes", async () => {
    const { client, requests } = storage({
      ram: [0, 3],
      read: (index) => Promise.resolve(new Uint8Array(MIB).fill(index + 1)),
    });
    const { snapshots, restores, events, disks } = session(client);

    await snapshots.restore(SNAPSHOT);

    expect(restores().map((call) => [call.name, ...call.args.slice(0, 1)])).toEqual([
      ["oxidevm_system_restore_validate", 32],
      ["oxidevm_system_restore_begin", 0],
      ["oxidevm_system_restore_ram_chunk", 0],
      ["oxidevm_system_restore_ram_chunk", 3],
      ["oxidevm_system_restore_finish", 0],
    ]);
    expect(events).toEqual(["stop", "restarted"]);
    expect(disks).toEqual(["none"]);
    expect(requests).toEqual(["prepare-restore", "stream-restore", "commit-restore-disk", "complete-restore"]);
  });

  it("stops before restore_finish when a streamed chunk fails verification", async () => {
    // The tenth chunk is read only after the core took the second, so the machine has stopped.
    const { client, requests } = storage({
      ram: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      read: (index) => (index === 9
        ? Promise.reject(new VMError("STORAGE_ERROR", "a snapshot object failed integrity validation", {
            reason: "snapshot-damaged",
          }))
        : Promise.resolve(new Uint8Array(MIB))),
    });
    const { snapshots, restores, events } = session(client);

    await expect(snapshots.restore(SNAPSHOT)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      detail: { reason: "snapshot-damaged" },
    });

    expect(restores().map((call) => call.name)).not.toContain("oxidevm_system_restore_finish");
    expect(events).toEqual(["stop", "lost"]);
    expect(requests).toEqual(["prepare-restore", "stream-restore", "abort"]);
  });

  it("leaves the machine running when storage cannot stream the restore", async () => {
    const { client, requests } = storage({
      ram: [0, 3],
      read: () => Promise.resolve(new Uint8Array(MIB)),
      streamFailure: new VMError("STORAGE_ERROR", "snapshot restore is not active"),
    });
    const { snapshots, restores, events } = session(client);

    await expect(snapshots.restore(SNAPSHOT)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "snapshot restore is not active",
    });

    expect(events).toEqual([]);
    expect(restores().map((call) => call.name)).toEqual([
      "oxidevm_system_restore_validate",
      "oxidevm_system_restore_abort",
    ]);
    expect(requests).toEqual(["prepare-restore", "stream-restore", "abort"]);
  });

  it("resumes the guest-agent session recorded with the snapshot", async () => {
    const agent: AgentResumeState = {
      dialect: 7, capabilities: 3 | 32, nextRequestId: 9, inbound: new Uint8Array(), inboundSkip: 0, inboundLost: false,
      outbound: new Uint8Array(), outboundSequence: 4, processes: [], consoleTail: new TextEncoder().encode("login: "),
    };
    const { client } = storage({ ram: [0], read: () => Promise.resolve(new Uint8Array(MIB)), agentState: encodeAgentResumeState(agent) });
    const { snapshots, agents } = session(client);

    await snapshots.restore(SNAPSHOT);

    expect(agents).toEqual([agent]);
  });

  it("returns what the restore brought back for the page that resumes it", async () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const agent: AgentResumeState = {
      dialect: 7, capabilities: 3 | 32, nextRequestId: 9, inbound: new Uint8Array(), inboundSkip: 0, inboundLost: false,
      outbound: new Uint8Array(), outboundSequence: 4, consoleTail: text("login: "),
      processes: [{ agentRequestId: 3, pid: 120, terminal: true, stdinOpen: true, command: "bun dev", tail: text("Ready") }],
    };
    const full = storage({
      ram: [0],
      read: () => Promise.resolve(new Uint8Array(MIB)),
      agentState: encodeAgentResumeState(agent),
      appData: text('{"tabs":2}'),
      newerFiles: true,
    });

    await expect(session(full.client).snapshots.restore(SNAPSHOT)).resolves.toEqual({
      newerFilesDropped: true,
      appData: text('{"tabs":2}'),
      consoleTail: text("login: "),
      processes: [{ agentRequestId: 3, command: "bun dev", terminal: true, tail: text("Ready") }],
    });
    const bare = storage({ ram: [0], read: () => Promise.resolve(new Uint8Array(MIB)) });
    await expect(session(bare.client).snapshots.restore(SNAPSHOT)).resolves.toEqual({
      newerFilesDropped: false,
      appData: null,
      consoleTail: new Uint8Array(),
      processes: [],
    });
  });

  it("reports a restore's progress in bytes, at most ten times a second, ending at the total", async () => {
    const ram = Array.from({ length: 12 }, (_, index) => index);
    const { client } = storage({ ram, read: () => Promise.resolve(new Uint8Array(MIB)) });
    const { snapshots, notices } = session(client);

    await snapshots.restore(SNAPSHOT);

    const progress = notices.filter((notice) => notice.type === "restore-progress");
    // Each chunk reads the clock 40 ms after the last: every third one is 120 ms later.
    expect(progress.length).toBeLessThan(ram.length);
    expect(progress.at(-1)).toEqual({ type: "restore-progress", completedBytes: 12 * MIB, totalBytes: 12 * MIB });
    expect(progress.every((notice, index) => index === 0 || notice.completedBytes > (progress[index - 1]?.completedBytes ?? 0))).toBe(true);
  });

  it("refuses a restore whose agent session record is damaged before replacing the machine", async () => {
    const { client, requests } = storage({ ram: [0], read: () => Promise.resolve(new Uint8Array(MIB)), agentState: new Uint8Array([1, 2, 3]) });
    const { snapshots, events } = session(client);

    await expect(snapshots.restore(SNAPSHOT)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "snapshot-damaged" } });

    expect(events).toEqual([]);
    expect(requests).toEqual(["prepare-restore", "abort"]);
  });
});

describe("snapshot session capture lineage", () => {
  afterEach(() => {
    for (const resource of opened.splice(0)) resource.close();
  });

  it("does not continue from a capture that finished after the machine was reset", async () => {
    const vm = dirtyCore([0]);
    const parents: (string | undefined)[] = [];
    const sessions: SnapshotSession[] = [];
    const { port1, port2 } = new MessageChannel();
    const server = serveSnapshotStorage(port1, (request) => {
      if (request.type === "open-capture") parents.push(request.parentId);
      // The control worker reinitializes the machine while the first capture is under way.
      if (request.type === "seal-capture" && parents.length === 1) for (const session of sessions) session.reset();
      return Promise.resolve(request.type === "commit-capture" ? SNAPSHOT : undefined);
    });
    const client = new SnapshotStorageClient(port2);
    opened.push({ close: () => { client.close(); void server.close(); } });
    const snapshots = new SnapshotSession({
      core: () => vm.core,
      storage: () => client,
      requireBooted: () => undefined,
      memoryBytes: () => 16 * MIB,
      shape: () => ({ memoryMiB: 16, vcpus: 1, profile: 2 }),
      freeze: () => Promise.resolve(() => undefined),
      precopy: () => false,
      stop: () => Promise.resolve(),
      restarted: () => undefined,
      agentState: () => undefined,
      syncFilesystems: () => Promise.resolve(),
      notify: () => undefined,
      now: () => 0,
      lost: () => undefined,
    });
    sessions.push(snapshots);

    await snapshots.capture({ kind: "automatic" });
    await snapshots.capture({ kind: "automatic" });

    expect(parents).toEqual([undefined, undefined]);
  });
});

describe("snapshot session page data", () => {
  afterEach(() => {
    for (const resource of opened.splice(0)) resource.close();
  });

  /** Storage that records each capture's open and seal requests and restores one snapshot. */
  function recordingStorage(restoredAppData: Uint8Array | undefined) {
    const opens: unknown[] = [];
    const seals: (Uint8Array | undefined)[] = [];
    const { port1, port2 } = new MessageChannel();
    const server = serveSnapshotStorage(port1, (request, signal) => {
      if (request.type === "open-capture") opens.push(request);
      if (request.type === "seal-capture") seals.push(request.appData);
      if (request.type === "prepare-restore") {
        return Promise.resolve({
          snapshot: SNAPSHOT,
          capturedAtUnixMs: 1_790_000_000_000,
          newerFiles: false,
          machineRecord: new Uint8Array(32),
          memoryBytes: 16 * MIB,
          ramChunks: [],
          disk: { mode: "none", bytes: 0, baseChunks: [], overlayChunks: [] },
          ...(restoredAppData === undefined ? {} : { appData: restoredAppData }),
        });
      }
      if (request.type === "stream-restore") return serveRestoreStream(request.port, [], signal);
      return Promise.resolve(request.type === "commit-capture" ? SNAPSHOT : undefined);
    });
    const client = new SnapshotStorageClient(port2);
    opened.push({ close: () => { client.close(); void server.close(); } });
    return { client, opens, seals };
  }

  function machine(
    client: SnapshotStorageClient,
    sync: () => Promise<void> = () => Promise.resolve(),
    notices: SnapshotEventRecord[] = [],
  ): SnapshotMachine {
    const vm = dirtyCore([0]);
    let clock = 0;
    return {
      core: () => vm.core,
      storage: () => client,
      requireBooted: () => undefined,
      memoryBytes: () => 16 * MIB,
      shape: () => ({ memoryMiB: 16, vcpus: 1, profile: 2 }),
      freeze: () => Promise.resolve(() => undefined),
      precopy: () => false,
      stop: () => Promise.resolve(),
      restarted: () => undefined,
      agentState: () => undefined,
      syncFilesystems: sync,
      notify: (event) => notices.push(event),
      now: () => (clock += 25),
      lost: () => undefined,
    };
  }

  it("saves the page's data with each restore point, and a restored point's data with the next", async () => {
    const restored = new TextEncoder().encode("restored tabs");
    const { client, seals } = recordingStorage(restored);
    const snapshots = new SnapshotSession(machine(client));

    snapshots.setAppData(new TextEncoder().encode("tabs"));
    await snapshots.capture({ kind: "automatic" });
    snapshots.setAppData(null);
    await snapshots.capture({ kind: "automatic" });
    await snapshots.restore(SNAPSHOT);
    await snapshots.capture({ kind: "automatic" });

    expect(seals).toEqual([
      new TextEncoder().encode("tabs"),
      undefined,
      restored,
    ]);
    expect(() => {
      snapshots.setAppData(new Uint8Array(1024 * 1024 + 1));
    }).toThrow(VMError);
  });

  it("asks the guest to write its files out before each save, and saves even when it cannot", async () => {
    const order: string[] = [];
    const { client, opens } = recordingStorage(undefined);
    let failSync = false;
    const snapshots = new SnapshotSession(machine(client, () => {
      order.push(`sync after ${String(opens.length)} opens`);
      return failSync ? Promise.reject(new Error("the guest agent is gone")) : Promise.resolve();
    }));

    await snapshots.capture({ kind: "automatic" });
    failSync = true;
    await snapshots.capture({ kind: "automatic" });

    expect(order).toEqual(["sync after 0 opens", "sync after 1 opens"]);
    expect(opens).toHaveLength(2);
  });

  it("tells the pages that follow it when a save starts, finishes and fails", async () => {
    const notices: SnapshotEventRecord[] = [];
    const { client } = recordingStorage(undefined);
    let failSave = false;
    const snapshots = new SnapshotSession(machine(client, () => (failSave ? Promise.reject(new Error("unused")) : Promise.resolve()), notices));

    const saved = await snapshots.capture({ kind: "named", label: "Before upgrading Next" });
    expect(saved.snapshot).toEqual(SNAPSHOT);
    expect(notices).toEqual([
      { type: "save-started", kind: "named" },
      {
        type: "save-finished",
        kind: "named",
        snapshot: SNAPSHOT,
        pauseMilliseconds: saved.pauseMilliseconds,
        durationMilliseconds: saved.durationMilliseconds,
      },
    ]);
    expect(saved.durationMilliseconds).toBeGreaterThan(saved.pauseMilliseconds);

    failSave = true;
    notices.length = 0;
    client.close();
    await expect(snapshots.capture({ kind: "automatic" })).rejects.toBeInstanceOf(VMError);
    expect(notices).toMatchObject([{ type: "save-started", kind: "automatic" }, { type: "save-failed", kind: "automatic" }]);
    const failed = notices[1];
    expect(failed?.type === "save-failed" ? typeof failed.error.code : undefined).toBe("string");
  });

  it("runs a workspace flush after the save under way, and holds the next save until it ends", async () => {
    const order: string[] = [];
    const { client } = recordingStorage(undefined);
    let saves = 0;
    const snapshots = new SnapshotSession(machine(client, () => {
      saves += 1;
      order.push(`save ${String(saves)}`);
      return Promise.resolve();
    }));
    const flushStarted = Promise.withResolvers<undefined>();
    const flushing = Promise.withResolvers<undefined>();

    const first = snapshots.capture({ kind: "automatic" });
    const flush = snapshots.exclusively(async () => {
      order.push("flush starts");
      flushStarted.resolve(undefined);
      await flushing.promise;
      order.push("flush ends");
    });
    const second = snapshots.capture({ kind: "automatic" });
    await first;
    await flushStarted.promise;
    expect(order).toEqual(["save 1", "flush starts"]);
    flushing.resolve(undefined);
    await flush;
    await second;

    expect(order).toEqual(["save 1", "flush starts", "flush ends", "save 2"]);
  });

  it("opens a safety point with its kind and name", async () => {
    const { client, opens } = recordingStorage(undefined);
    const snapshots = new SnapshotSession(machine(client));

    await snapshots.capture({ kind: "safety", label: "Before restore" });

    expect(opens).toMatchObject([{ kind: "safety", label: "Before restore" }]);
  });
});


it("returns selected image metadata admitted before restore publication",async()=>{
 const systemImage={id:"selected",version:"old",runtimes:{kind:"custom",versions:{python:"3.13"}}} as const;
 const full=storage({ram:[0],read:()=>Promise.resolve(new Uint8Array(MIB)),systemImage});
 expect((await session(full.client).snapshots.restore(SNAPSHOT)).systemImage).toEqual(systemImage);
});
