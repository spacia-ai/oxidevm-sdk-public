import { describe, expect, it } from "vitest";

import {
  createDiskBridgeBuffer,
  DISK_BRIDGE_COMMAND_CAPACITY,
  DISK_BRIDGE_COMMAND_HEAD,
  DISK_BRIDGE_COMMAND_TAIL,
  DISK_BRIDGE_COMPLETION_CAPACITY,
  DISK_BRIDGE_COMPLETION_SEQUENCE,
  DISK_BRIDGE_DESCRIPTOR_FLAGS,
  DISK_BRIDGE_DESCRIPTOR_SEQUENCE,
  DISK_BRIDGE_FAILURE_PROTOCOL,
  DISK_BRIDGE_FLUSH,
  DISK_BRIDGE_GENERATION,
  DISK_BRIDGE_POLL_BACKEND_ERROR,
  DISK_BRIDGE_POLL_READY,
  DISK_BRIDGE_STICKY_REASON,
  DISK_BRIDGE_STICKY_SEQUENCE,
  DISK_BRIDGE_SUBMIT_ACCEPTED,
  DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  DISK_BRIDGE_SUBMIT_BUSY,
  DISK_BRIDGE_SYNC_BARRIER,
  DISK_BRIDGE_SYNC_OPERATION,
  DISK_BRIDGE_SYNC_REQUESTED,
  DISK_BRIDGE_SYNC_RESPONDED,
  DISK_BRIDGE_SYNC_SEQUENCE,
  DISK_BRIDGE_SYNC_STATE,
  DiskBridgeClient,
  diskBridgeViews,
} from "../disk-bridge.js";
import {
  StorageDiskBridge,
  type StorageBridgeDisk,
} from "./storage-disk-bridge.js";

class FakeDisk implements StorageBridgeDisk {
  readonly events: string[] = [];
  readonly bytes = new Map<number, number>();
  failWrite = false;
  quotaWrite = false;
  failRead = false;
  sharedWrite = false;
  storeWrites = true;

  read(offset: number, target: Uint8Array): void {
    this.events.push(`read:${offset}:${target.byteLength}`);
    if (this.failRead) throw new Error("read failed");
    for (let index = 0; index < target.byteLength; index += 1) {
      target[index] = this.bytes.get(offset + index) ?? 0;
    }
  }

  write(offset: number, source: Uint8Array): void {
    this.events.push(`write:${offset}:${source.byteLength}`);
    this.sharedWrite = source.buffer instanceof SharedArrayBuffer;
    if (this.failWrite) throw new Error("write failed");
    if (this.quotaWrite) throw new DOMException("origin quota exhausted", "QuotaExceededError");
    if (!this.storeWrites) return;
    for (let index = 0; index < source.byteLength; index += 1) {
      this.bytes.set(offset + index, source[index] ?? 0);
    }
  }

  zero(offset: number, length: number): void {
    this.events.push(`zero:${offset}:${length}`);
  }

  flush(): void {
    this.events.push("flush");
  }
}

describe("storage disk bridge", () => {
  it("drains write payloads directly from the SAB", () => {
    const { client, disk, storage, memory, generation } = setup();
    new Uint8Array(memory.buffer, 8, 4).set([1, 2, 3, 4]);
    expect(client.imports.disk_write(16, 0, 8, 4)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(disk.sharedWrite).toBe(true);
    expect(disk.events).toEqual(["write:16:4"]);
    expect([...disk.bytes.values()]).toEqual([1, 2, 3, 4]);
    expect(client.commandDepth()).toBe(0);
    close(client, storage);
  });

  it("completes deferred reads into Wasm memory", () => {
    const { client, disk, storage, memory, generation } = setup();
    disk.bytes.set(20, 9);
    disk.bytes.set(21, 8);
    expect(client.imports.disk_read_start(7, 20, 0, 2)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(client.imports.disk_poll(7, 64, 2)).toBe(DISK_BRIDGE_POLL_READY);
    expect(Array.from(new Uint8Array(memory.buffer, 64, 2))).toEqual([9, 8]);
    close(client, storage);
  });

  it("rejects an invalid deferred-read Wasm pointer", () => {
    const { client, storage, memory, generation } = setup();
    expect(client.imports.disk_read_start(7, 0, 0, 2)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(
      client.imports.disk_poll(7, memory.buffer.byteLength, 2),
    ).toBe(DISK_BRIDGE_POLL_BACKEND_ERROR);
    expect(client.pendingCount()).toBe(0);
    close(client, storage);
  });

  it("rejects a completion whose sequence does not match its command", () => {
    const { buffer, client, storage, generation } = setup();
    expect(client.imports.disk_read_start(7, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    const views = diskBridgeViews(buffer);
    Atomics.add(views.completions, DISK_BRIDGE_COMPLETION_SEQUENCE, 1);
    expect(client.imports.disk_poll(7, 0, 1)).toBe(
      DISK_BRIDGE_POLL_BACKEND_ERROR,
    );
    expect(Atomics.load(views.control, DISK_BRIDGE_STICKY_REASON)).toBe(
      DISK_BRIDGE_FAILURE_PROTOCOL,
    );
    close(client, storage);
  });

  it("services a flush only after its captured mutation barrier", () => {
    const { buffer, client, disk, storage, memory, generation } = setup();
    new Uint8Array(memory.buffer, 0, 1)[0] = 7;
    expect(client.imports.disk_write(4, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    const { control } = diskBridgeViews(buffer);
    const barrier = Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD);
    expect(client.imports.disk_write(8, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    Atomics.store(control, DISK_BRIDGE_SYNC_STATE, DISK_BRIDGE_SYNC_REQUESTED);
    Atomics.store(control, DISK_BRIDGE_SYNC_OPERATION, DISK_BRIDGE_FLUSH);
    Atomics.store(control, DISK_BRIDGE_SYNC_SEQUENCE, 9);
    Atomics.store(
      control,
      DISK_BRIDGE_SYNC_BARRIER,
      barrier,
    );
    storage.service({
      version: 2,
      type: "disk-sync",
      generation,
      sequence: 9,
    });
    expect(disk.events).toEqual(["write:4:1", "flush"]);
    expect(Atomics.load(control, DISK_BRIDGE_SYNC_STATE)).toBe(
      DISK_BRIDGE_SYNC_RESPONDED,
    );
    storage.service(kick(generation));
    expect(disk.events).toEqual(["write:4:1", "flush", "write:8:1"]);
    close(client, storage);
  });

  it("sticks on asynchronous failure and rejects every later operation", () => {
    const { buffer, client, disk, storage, memory, generation } = setup();
    disk.failWrite = true;
    new Uint8Array(memory.buffer, 0, 1)[0] = 1;
    expect(client.imports.disk_write(0, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    const { control } = diskBridgeViews(buffer);
    expect(Atomics.load(control, DISK_BRIDGE_STICKY_SEQUENCE)).not.toBe(0);
    expect(client.imports.disk_zero(0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
    );
    expect(client.profile().stickyFailure?.reason).toBe("backend");
    close(client, storage);
  });

  it("reports an exhausted origin quota as its own sticky reason", () => {
    const { client, disk, storage, memory, generation } = setup();
    disk.quotaWrite = true;
    new Uint8Array(memory.buffer, 0, 1)[0] = 1;
    expect(client.imports.disk_write(0, 0, 0, 1)).toBe(DISK_BRIDGE_SUBMIT_ACCEPTED);
    storage.service(kick(generation));
    // The guest still observes a block I/O error; the host names the quota,
    // and every operation refused by the sticky failure counts against it.
    expect(client.imports.disk_zero(0, 0, 1)).toBe(DISK_BRIDGE_SUBMIT_BACKEND_ERROR);
    expect(client.profile()).toMatchObject({
      requests: 2, failures: 2, delayedFailures: 1, backendFailures: 0, protocolFailures: 0, quotaFailures: 2,
      stickyFailure: { sequence: 1, reason: "quota", operation: "write", offset: 0, length: 1 },
    });
    close(client, storage);
  });

  it("counts a delayed read failure exactly once", () => {
    const { client, disk, storage, generation } = setup();
    disk.failRead = true;
    expect(client.imports.disk_read_start(7, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(client.imports.disk_poll(7, 0, 1)).toBe(
      DISK_BRIDGE_POLL_BACKEND_ERROR,
    );
    expect(client.profile()).toMatchObject({
      requests: 1,
      failures: 1,
      delayedFailures: 1,
      backendFailures: 1,
      stickyFailure: {
        sequence: 1,
        reason: "backend",
        operation: "read",
        offset: 0,
        length: 1,
      },
    });
    close(client, storage);
  });

  it("returns Busy when the descriptor ring is full", () => {
    const { buffer, client, storage, memory, generation } = setup();
    for (let index = 0; index < DISK_BRIDGE_COMMAND_CAPACITY; index += 1) {
      expect(client.imports.disk_write(index, 0, 0, 1)).toBe(
        DISK_BRIDGE_SUBMIT_ACCEPTED,
      );
    }
    expect(client.imports.disk_write(999, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_BUSY,
    );
    storage.service(kick(generation));
    expect(client.imports.disk_write(999, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(
      Atomics.load(
        diskBridgeViews(buffer).control,
        DISK_BRIDGE_STICKY_SEQUENCE,
      ),
    ).toBe(0);
    expect(memory.buffer.byteLength).toBeGreaterThan(0);
    close(client, storage);
  });

  it("retries after write-arena backpressure without skipping a sequence", () => {
    const { buffer, client, disk, storage, memory, generation } = setup();
    const writeLength = 1024 * 1024;
    memory.grow(255);
    disk.storeWrites = false;
    for (let index = 0; index < 16; index += 1) {
      expect(client.imports.disk_write(index * writeLength, 0, 0, writeLength)).toBe(
        DISK_BRIDGE_SUBMIT_ACCEPTED,
      );
    }
    expect(client.imports.disk_write(16 * writeLength, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_BUSY,
    );
    storage.service(kick(generation));
    expect(client.imports.disk_write(16 * writeLength, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    storage.service(kick(generation));
    expect(
      Atomics.load(
        diskBridgeViews(buffer).control,
        DISK_BRIDGE_STICKY_SEQUENCE,
      ),
    ).toBe(0);
    close(client, storage);
  });

  it("backpressures instead of failing when the completion ring is full", () => {
    const { buffer, client, storage, generation } = setup();
    for (let id = 1; id <= DISK_BRIDGE_COMPLETION_CAPACITY; id += 1) {
      expect(client.imports.disk_read_start(id, id, 0, 1)).toBe(
        DISK_BRIDGE_SUBMIT_ACCEPTED,
      );
    }
    storage.service(kick(generation));
    expect(client.commandDepth()).toBe(0);
    expect(
      client.imports.disk_read_start(
        DISK_BRIDGE_COMPLETION_CAPACITY + 1,
        0,
        0,
        1,
      ),
    ).toBe(DISK_BRIDGE_SUBMIT_ACCEPTED);
    storage.service(kick(generation));
    expect(client.commandDepth()).toBe(1);
    expect(client.imports.disk_poll(1, 0, 1)).toBe(DISK_BRIDGE_POLL_READY);
    storage.service(kick(generation));
    expect(client.commandDepth()).toBe(0);
    expect(
      Atomics.load(
        diskBridgeViews(buffer).control,
        DISK_BRIDGE_STICKY_SEQUENCE,
      ),
    ).toBe(0);
    close(client, storage);
  });

  it("rejects nonzero reserved descriptor fields", () => {
    const { buffer, client, storage, memory, generation } = setup();
    new Uint8Array(memory.buffer, 0, 1)[0] = 1;
    expect(client.imports.disk_write(0, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    const views = diskBridgeViews(buffer);
    Atomics.store(views.commands, DISK_BRIDGE_DESCRIPTOR_FLAGS, 1);
    storage.service(kick(generation));
    expect(Atomics.load(views.control, DISK_BRIDGE_STICKY_REASON)).toBe(
      DISK_BRIDGE_FAILURE_PROTOCOL,
    );
    expect(Atomics.load(views.control, DISK_BRIDGE_COMMAND_TAIL)).toBe(
      Atomics.load(views.control, DISK_BRIDGE_COMMAND_HEAD),
    );
    close(client, storage);
  });

  it("rejects a non-monotonic command sequence", () => {
    const { buffer, client, storage, memory, generation } = setup();
    new Uint8Array(memory.buffer, 0, 1)[0] = 1;
    expect(client.imports.disk_write(0, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_ACCEPTED,
    );
    const views = diskBridgeViews(buffer);
    Atomics.store(views.commands, DISK_BRIDGE_DESCRIPTOR_SEQUENCE, 2);
    storage.service(kick(generation));
    expect(Atomics.load(views.control, DISK_BRIDGE_STICKY_REASON)).toBe(
      DISK_BRIDGE_FAILURE_PROTOCOL,
    );
    close(client, storage);
  });

  it("resets a quiescent generation with an acknowledged handshake", async () => {
    const { buffer, client, storage } = setup();
    await client.reset();
    expect(
      Atomics.load(diskBridgeViews(buffer).control, DISK_BRIDGE_GENERATION),
    ).toBe(2);
    close(client, storage);
  });
});

function setup(): {
  readonly buffer: SharedArrayBuffer;
  readonly client: DiskBridgeClient;
  readonly disk: FakeDisk;
  readonly storage: StorageDiskBridge;
  readonly memory: WebAssembly.Memory;
  readonly generation: number;
} {
  const buffer = createDiskBridgeBuffer();
  const channel = new MessageChannel();
  const disk = new FakeDisk();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const client = new DiskBridgeClient(buffer, channel.port1, () => memory);
  client.configureProfiling(true);
  const storage = new StorageDiskBridge(buffer, channel.port2, () => disk);
  return { buffer, client, disk, storage, memory, generation: 1 };
}

function kick(generation: number): unknown {
  return { version: 2, type: "disk-kick", generation };
}

function close(client: DiskBridgeClient, storage: StorageDiskBridge): void {
  client.close();
  storage.close();
}
