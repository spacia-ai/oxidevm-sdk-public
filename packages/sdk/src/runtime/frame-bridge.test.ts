import { describe, expect, it } from "vitest";

import { VMError } from "./errors.ts";
import {
  advanceFrameBridgeGeneration,
  clearFrameBridgeKick,
  createFrameBridgeBuffer,
  decodeFrameBridgeNotice,
  decodeFrameBridgeReply,
  decodeNetworkLinkConnection,
  encodeFrameRecords,
  FRAME_BRIDGE_RING_BYTES,
  FRAME_BRIDGE_TOTAL_BYTES,
  FRAME_BRIDGE_WORD,
  FrameBridgeDoorbell,
  frameBridgeGeneration,
  frameRecordEnds,
  FrameRing,
  publishRouterCounters,
  publishRouterGeneration,
  readRouterCounters,
  routerGeneration,
  validateFrameBridgeBuffer,
} from "./frame-bridge.ts";
import { PROTOCOL_VERSION } from "./protocol/common.ts";

function frame(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + seed) & 0xff);
}

function control(buffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(buffer, 0, 16);
}

/** Both counters of a ring start `offset` bytes before its end. */
function startNearEnd(buffer: SharedArrayBuffer, head: number, tail: number, offset: number): void {
  Atomics.store(control(buffer), head, FRAME_BRIDGE_RING_BYTES - offset);
  Atomics.store(control(buffer), tail, FRAME_BRIDGE_RING_BYTES - offset);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "none";
}

describe("frame rings", () => {
  it("carries a record whose length header straddles the end of the ring", () => {
    const buffer = createFrameBridgeBuffer();
    startNearEnd(buffer, FRAME_BRIDGE_WORD.toLinuxHead, FRAME_BRIDGE_WORD.toLinuxTail, 1);
    const sent = frame(60);
    const ring = new FrameRing(buffer, "to-linux");
    ring.write(encodeFrameRecords([sent]));
    const out = new Uint8Array(4096);
    const peek = ring.peek(out);
    expect(peek.recordEnds).toEqual([62]);
    expect(out.subarray(0, 2)).toEqual(Uint8Array.of(60, 0));
    expect(out.subarray(2, 62)).toEqual(sent);
    ring.advance(62);
    expect(ring.usedBytes()).toBe(0);
  });

  it("carries frame bytes split across the end of the ring", () => {
    const buffer = createFrameBridgeBuffer();
    startNearEnd(buffer, FRAME_BRIDGE_WORD.toRouterHead, FRAME_BRIDGE_WORD.toRouterTail, 30);
    const first = frame(1514, 3);
    const second = frame(14, 9);
    const ring = new FrameRing(buffer, "to-router");
    ring.write(encodeFrameRecords([first, second]));
    const out = new Uint8Array(4096);
    const peek = ring.peek(out);
    expect(peek).toEqual({ length: 1532, recordEnds: [1516, 1532] });
    expect(out.subarray(2, 1516)).toEqual(first);
    expect(out.subarray(1518, 1532)).toEqual(second);
  });

  it("refuses records a full ring cannot take and reports its free space exactly", () => {
    const ring = new FrameRing(createFrameBridgeBuffer(), "to-linux");
    const record = encodeFrameRecords([frame(1514)]);
    const fits = Math.floor(FRAME_BRIDGE_RING_BYTES / record.byteLength);
    for (let index = 0; index < fits; index += 1) ring.write(record);
    expect(ring.usedBytes()).toBe(fits * record.byteLength);
    expect(ring.freeBytes()).toBe(FRAME_BRIDGE_RING_BYTES - fits * record.byteLength);
    expect(codeOf(() => { ring.write(record); })).toBe("PROTOCOL_ERROR");
    expect(ring.usedBytes()).toBe(fits * record.byteLength);
  });

  it("rejects a ring whose counters claim more than it holds", () => {
    const buffer = createFrameBridgeBuffer();
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.toLinuxHead, FRAME_BRIDGE_RING_BYTES + 1);
    const ring = new FrameRing(buffer, "to-linux");
    expect(codeOf(() => ring.usedBytes())).toBe("PROTOCOL_ERROR");
    expect(codeOf(() => ring.peek(new Uint8Array(64)))).toBe("PROTOCOL_ERROR");
  });

  it("keeps working after its counters wrap past 2^32", () => {
    const buffer = createFrameBridgeBuffer();
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.toLinuxHead, -20);
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.toLinuxTail, -20);
    const ring = new FrameRing(buffer, "to-linux");
    ring.write(encodeFrameRecords([frame(100)]));
    expect(Atomics.load(control(buffer), FRAME_BRIDGE_WORD.toLinuxHead)).toBe(82);
    expect(ring.peek(new Uint8Array(4096)).recordEnds).toEqual([102]);
  });

  it("peeks only the whole records that fit and advances exactly past them", () => {
    const ring = new FrameRing(createFrameBridgeBuffer(), "to-router");
    ring.write(encodeFrameRecords([frame(60), frame(60), frame(60)]));
    const out = new Uint8Array(130);
    expect(ring.peek(out)).toEqual({ length: 124, recordEnds: [62, 124] });
    ring.advance(124);
    expect(ring.usedBytes()).toBe(62);
    expect(codeOf(() => { ring.advance(63); })).toBe("PROTOCOL_ERROR");
    ring.skipAll();
    expect(ring.usedBytes()).toBe(0);
  });

  it.each([
    ["shorter than an Ethernet header", Uint8Array.of(13, 0, ...frame(13))],
    ["longer than 1514 bytes", Uint8Array.of(0xeb, 0x05, ...frame(1515))],
    ["truncated", Uint8Array.of(60, 0, ...frame(20))],
    ["a lone length byte", Uint8Array.of(60)],
  ])("rejects records %s", (_name, records) => {
    expect(codeOf(() => frameRecordEnds(records))).toBe("PROTOCOL_ERROR");
    const ring = new FrameRing(createFrameBridgeBuffer(), "to-router");
    expect(codeOf(() => { ring.write(records); })).toBe("PROTOCOL_ERROR");
    expect(ring.usedBytes()).toBe(0);
  });

  it("rejects an out-of-bounds record a writer left in the ring", () => {
    const buffer = createFrameBridgeBuffer();
    const data = new Uint8Array(buffer, FRAME_BRIDGE_TOTAL_BYTES - FRAME_BRIDGE_RING_BYTES, 4);
    data.set([13, 0]);
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.toLinuxHead, 15);
    expect(codeOf(() => new FrameRing(buffer, "to-linux").peek(new Uint8Array(64)))).toBe("PROTOCOL_ERROR");
  });
});

describe("the doorbell and generations", () => {
  it("posts once until the network worker clears the kick", () => {
    const buffer = createFrameBridgeBuffer();
    const posted: unknown[] = [];
    const port = { postMessage: (message: unknown) => { posted.push(message); } };
    const doorbell = new FrameBridgeDoorbell(buffer, port);
    expect([doorbell.ring(), doorbell.ring(), doorbell.ring()]).toEqual([true, false, false]);
    expect(posted).toEqual([{ version: 1, type: "frames", generation: 0 }]);
    clearFrameBridgeKick(buffer);
    advanceFrameBridgeGeneration(buffer);
    expect(doorbell.ring()).toBe(true);
    expect(posted.at(-1)).toEqual({ version: 1, type: "frames", generation: 1 });
  });

  it("advances the generation within 31 bits and tracks the router's acknowledgement", () => {
    const buffer = createFrameBridgeBuffer();
    expect([frameBridgeGeneration(buffer), routerGeneration(buffer)]).toEqual([0, 0]);
    expect(advanceFrameBridgeGeneration(buffer)).toBe(1);
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.generation, 0x7fff_ffff);
    expect(advanceFrameBridgeGeneration(buffer)).toBe(0);
    publishRouterGeneration(buffer, 0x7fff_ffff);
    expect(routerGeneration(buffer)).toBe(0x7fff_ffff);
  });
});

describe("router counters on the bridge", () => {
  it("read back only once published, and only while no publish is in progress", () => {
    const buffer = createFrameBridgeBuffer();
    expect(readRouterCounters(buffer)).toBeUndefined();
    publishRouterCounters(buffer, frame(328, 1));
    expect(readRouterCounters(buffer)).toEqual(frame(328, 1));
    publishRouterCounters(buffer, frame(328, 2));
    expect(readRouterCounters(buffer)).toEqual(frame(328, 2));
    // An odd sequence is a publish the network worker has begun and not finished.
    Atomics.add(control(buffer), FRAME_BRIDGE_WORD.routerCountersSequence, 1);
    expect(readRouterCounters(buffer)).toBeUndefined();
  });

  it("refuses a record larger than its 512-byte slot", () => {
    expect(codeOf(() => { publishRouterCounters(createFrameBridgeBuffer(), frame(513)); })).toBe("PROTOCOL_ERROR");
  });
});

describe("bridge messages", () => {
  it("validates the shared buffer's size and version", () => {
    const buffer = createFrameBridgeBuffer();
    expect(validateFrameBridgeBuffer(buffer)).toBe(buffer);
    expect(codeOf(() => validateFrameBridgeBuffer(new SharedArrayBuffer(2 * 1024 * 1024)))).toBe("PROTOCOL_ERROR");
    expect(codeOf(() => validateFrameBridgeBuffer(new ArrayBuffer(FRAME_BRIDGE_TOTAL_BYTES)))).toBe("PROTOCOL_ERROR");
    Atomics.store(control(buffer), FRAME_BRIDGE_WORD.version, 2);
    expect(codeOf(() => validateFrameBridgeBuffer(buffer))).toBe("PROTOCOL_ERROR");
  });

  it("decodes the doorbell and reply messages exactly", () => {
    expect(decodeFrameBridgeNotice({ version: 1, type: "frames", generation: 3 })).toEqual({ version: 1, type: "frames", generation: 3 });
    expect(decodeFrameBridgeReply({ version: 1, type: "router-ready" })).toEqual({ version: 1, type: "router-ready" });
    for (const reason of ["fetch", "compile", "exports", "version", "init", "trap", "protocol"]) {
      expect(decodeFrameBridgeReply({ version: 1, type: "router-failed", reason }))
        .toEqual({ version: 1, type: "router-failed", reason });
    }
    for (const bad of [
      { version: 2, type: "frames", generation: 3 },
      { version: 1, type: "frames", generation: -1 },
      { version: 1, type: "frames", generation: 3, extra: true },
      "frames",
    ]) expect(codeOf(() => decodeFrameBridgeNotice(bad))).toBe("PROTOCOL_ERROR");
    for (const bad of [
      { version: 1, type: "router-failed", reason: "crash" },
      { version: 1, type: "router-ready", reason: "trap" },
      { version: 2, type: "router-ready" },
    ]) expect(codeOf(() => decodeFrameBridgeReply(bad))).toBe("PROTOCOL_ERROR");
  });

  it("decodes the main thread's connect-link message exactly", () => {
    const bridge = createFrameBridgeBuffer();
    const { port1: doorbell } = new MessageChannel();
    const message = {
      version: PROTOCOL_VERSION,
      type: "connect-link",
      bridge,
      doorbell,
      netstackWasmUrl: "https://ide.example.test/oxidevm_netstack.wasm",
    };
    expect(decodeNetworkLinkConnection(message)).toEqual(message);
    const verifiedBlob = { ...message, netstackWasmUrl: "blob:https://ide.example.test/b7d490a0-2f85-4c53-871a-15f6f37b4949" };
    expect(decodeNetworkLinkConnection(verifiedBlob)).toEqual(verifiedBlob);
    for (const bad of [
      { ...message, extra: 1 },
      { ...message, version: PROTOCOL_VERSION + 1 },
      { ...message, bridge: new SharedArrayBuffer(2 * 1024 * 1024) },
      { ...message, doorbell: {} },
      { ...message, netstackWasmUrl: "/oxidevm_netstack.wasm" },
      { ...message, netstackWasmUrl: "file:///oxidevm_netstack.wasm" },
      { ...message, netstackWasmUrl: `https://ide.example.test/${"x".repeat(2_048)}` },
    ]) expect(codeOf(() => decodeNetworkLinkConnection(bad))).toBe("PROTOCOL_ERROR");
    doorbell.close();
  });
});
