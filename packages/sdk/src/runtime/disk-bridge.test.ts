import { describe, expect, it } from "vitest";

import {
  createDiskBridgeBuffer,
  decodeDiskBridgeNotice,
  DISK_BRIDGE_COMMAND_BYTES,
  DISK_BRIDGE_COMMAND_CAPACITY,
  DISK_BRIDGE_COMMAND_HEAD,
  DISK_BRIDGE_COMMAND_OFFSET,
  DISK_BRIDGE_COMMAND_TAIL,
  DISK_BRIDGE_COMPLETION_BYTES,
  DISK_BRIDGE_COMPLETION_OFFSET,
  DISK_BRIDGE_CONTROL_BYTES,
  DISK_BRIDGE_READ_ARENA_BYTES,
  DISK_BRIDGE_READ_ARENA_OFFSET,
  DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  DISK_BRIDGE_SUBMIT_BUSY,
  DISK_BRIDGE_SYNC_BYTES,
  DISK_BRIDGE_SYNC_OFFSET,
  DISK_BRIDGE_TOTAL_BYTES,
  DISK_BRIDGE_VERSION,
  DISK_BRIDGE_WRITE,
  DISK_BRIDGE_WRITE_ARENA_BYTES,
  DISK_BRIDGE_WRITE_ARENA_OFFSET,
  DiskBridgeClient,
  diskBridgeReservation,
  diskBridgeViews,
} from "./disk-bridge.js";

describe("host disk bridge", () => {
  it("allocates the exact v2 rings and arenas", () => {
    const buffer = createDiskBridgeBuffer();
    const views = diskBridgeViews(buffer);
    expect(DISK_BRIDGE_VERSION).toBe(2);
    expect(DISK_BRIDGE_COMMAND_OFFSET).toBe(4096);
    expect(DISK_BRIDGE_COMPLETION_OFFSET).toBe(12_288);
    expect(DISK_BRIDGE_WRITE_ARENA_OFFSET).toBe(20_480);
    expect(DISK_BRIDGE_READ_ARENA_OFFSET).toBe(16_797_696);
    expect(DISK_BRIDGE_SYNC_OFFSET).toBe(33_574_912);
    expect(DISK_BRIDGE_TOTAL_BYTES).toBe(34_623_488);
    expect(buffer.byteLength).toBe(DISK_BRIDGE_TOTAL_BYTES);
    expect(views.control.byteLength).toBe(DISK_BRIDGE_CONTROL_BYTES);
    expect(views.commands.byteLength).toBe(DISK_BRIDGE_COMMAND_BYTES);
    expect(views.completions.byteLength).toBe(DISK_BRIDGE_COMPLETION_BYTES);
    expect(views.writeArena.byteLength).toBe(DISK_BRIDGE_WRITE_ARENA_BYTES);
    expect(views.readArena.byteLength).toBe(DISK_BRIDGE_READ_ARENA_BYTES);
    expect(views.syncWindow.byteLength).toBe(DISK_BRIDGE_SYNC_BYTES);
  });

  it("strictly decodes kick notifications", () => {
    expect(
      decodeDiskBridgeNotice({
        version: 2,
        type: "disk-kick",
        generation: 7,
      }),
    ).toEqual({ version: 2, type: "disk-kick", generation: 7 });
    expect(() =>
      decodeDiskBridgeNotice({
        version: 2,
        type: "disk-kick",
        generation: 7,
        extra: true,
      }),
    ).toThrow();
  });

  it("reserves wrapped arena spans without ambiguous occupancy", () => {
    const capacity = DISK_BRIDGE_WRITE_ARENA_BYTES;
    expect(diskBridgeReservation(capacity - 4, capacity - 4, 8, capacity)).toEqual({
      offset: 0,
      padding: 4,
      nextHead: capacity + 8,
    });
    expect(diskBridgeReservation(0xffff_fff0, 0xffff_fff0, 32, capacity)).toEqual({
      offset: 0,
      padding: 16,
      nextHead: 32,
    });
    expect(diskBridgeReservation(capacity, 0, 1, capacity)).toBeUndefined();
  });

  it("admits writes without blocking and publishes one descriptor", () => {
    const buffer = createDiskBridgeBuffer();
    const channel = new MessageChannel();
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 4).set([1, 2, 3, 4]);
    const client = new DiskBridgeClient(buffer, channel.port1, () => memory);
    expect(client.imports.disk_write(9, 0, 32, 4)).toBe(0);
    const views = diskBridgeViews(buffer);
    expect(Atomics.load(views.control, DISK_BRIDGE_COMMAND_HEAD)).toBe(1);
    expect(Atomics.load(views.commands, 2)).toBe(DISK_BRIDGE_WRITE);
    expect(Array.from(views.writeArena.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(Atomics.load(views.control, DISK_BRIDGE_COMMAND_HEAD)).toBeLessThanOrEqual(
      DISK_BRIDGE_COMMAND_CAPACITY,
    );
    client.close();
    channel.port2.close();
  });

  it("wraps command counters without losing occupancy", () => {
    const buffer = createDiskBridgeBuffer();
    const views = diskBridgeViews(buffer);
    Atomics.store(views.control, DISK_BRIDGE_COMMAND_HEAD, -1);
    Atomics.store(views.control, DISK_BRIDGE_COMMAND_TAIL, -1);
    const channel = new MessageChannel();
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer)[0] = 7;
    const client = new DiskBridgeClient(buffer, channel.port1, () => memory);
    expect(client.imports.disk_write(0, 0, 0, 1)).toBe(0);
    expect(Atomics.load(views.control, DISK_BRIDGE_COMMAND_HEAD)).toBe(0);
    expect(client.commandDepth()).toBe(1);
    client.close();
    channel.port2.close();
  });

  it("bounds deferred reads by the 16 MiB arena", () => {
    const channel = new MessageChannel();
    const client = new DiskBridgeClient(
      createDiskBridgeBuffer(),
      channel.port1,
      () => new WebAssembly.Memory({ initial: 1 }),
    );
    expect(
      client.imports.disk_read_start(1, 0, 0, DISK_BRIDGE_READ_ARENA_BYTES),
    ).toBe(0);
    expect(client.imports.disk_read_start(2, 0, 0, 1)).toBe(
      DISK_BRIDGE_SUBMIT_BUSY,
    );
    client.close();
    channel.port2.close();
  });

  it("rejects invalid Wasm write pointers without publishing", () => {
    const buffer = createDiskBridgeBuffer();
    const channel = new MessageChannel();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const client = new DiskBridgeClient(buffer, channel.port1, () => memory);
    client.configureProfiling(true);
    expect(
      client.imports.disk_write(0, 0, memory.buffer.byteLength, 1),
    ).toBe(DISK_BRIDGE_SUBMIT_BACKEND_ERROR);
    expect(client.commandDepth()).toBe(0);
    expect(client.profile()).toMatchObject({
      requests: 1,
      failures: 1,
      protocolFailures: 1,
    });
    client.close();
    channel.port2.close();
  });

  it("keeps disk profiling opt-in and resettable", () => {
    const channel = new MessageChannel();
    const client = new DiskBridgeClient(
      createDiskBridgeBuffer(),
      channel.port1,
      () => new WebAssembly.Memory({ initial: 1 }),
    );
    expect(client.profile().enabled).toBe(false);
    client.configureProfiling(true);
    expect(client.profile()).toMatchObject({
      enabled: true,
      requests: 0,
      readBytes: 0,
      writtenBytes: 0,
      busyReturns: 0,
      maximumInFlight: 0,
    });
    client.configureProfiling(false);
    expect(client.profile().enabled).toBe(false);
    client.close();
    channel.port2.close();
  });
});
