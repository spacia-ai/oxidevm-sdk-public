import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../../errors.js";
import {
  advanceFrameBridgeGeneration,
  createFrameBridgeBuffer,
  encodeFrameRecords,
  FRAME_BRIDGE_RING_BYTES,
  FRAME_BRIDGE_WORD,
  frameBridgeGeneration,
  frameRecordEnds,
  FrameRing,
  type NetworkLinkConnection,
  readRouterCounters,
  routerGeneration,
} from "../../frame-bridge.js";
import type { RouterConnectionState, RouterConnectionStatus } from "../../netstack-abi.js";
import { PROTOCOL_VERSION } from "../../protocol/common.js";
import { NetstackConnections, type RouterConnection, type RouterOpenResult } from "./connections.js";
import type { NetstackRouterApi, RouterOpen } from "./router.js";

/** A scripted router: tests set connection states, queue frames and data, and read the calls. */
class FakeRouter implements NetstackRouterApi {
  readonly inits: bigint[] = [];
  readonly framesSeen: Uint8Array[] = [];
  readonly outbound: Uint8Array[] = [];
  readonly opened: number[] = [];
  readonly closed: number[] = [];
  readonly sent = new Map<number, number[]>();
  readonly inbound = new Map<number, number[]>();
  readonly states = new Map<number, RouterConnectionState>();
  readonly record = Uint8Array.from({ length: 352 }, (_, index) => index & 0xff);
  delay: number | undefined = 5;
  sendRoom = 1 << 20;
  trap = false;
  #next = 0;

  setNetwork(): void {}
  egressNext(): undefined { return undefined; }
  egressComplete(): boolean { return true; }
  egressStatus(): number { return 0; }
  egressSend(): number { return 0; }
  egressReceive(): Uint8Array<ArrayBuffer> { return new Uint8Array(); }

  init(seed: bigint): void {
    this.#check();
    this.inits.push(seed);
    for (const [id, state] of this.states) this.states.set(id, state === "opening" ? "refused" : "reset");
  }

  framesIn(records: Uint8Array): number {
    this.#check();
    let start = 0;
    for (const end of frameRecordEnds(records)) {
      this.framesSeen.push(records.slice(start + 2, end));
      start = end;
    }
    return frameRecordEnds(records).length;
  }

  framesOut(maximumBytes: number): Uint8Array<ArrayBuffer> {
    this.#check();
    const frames: Uint8Array[] = [];
    let length = 0;
    for (let next = this.outbound[0]; next !== undefined && length + 2 + next.byteLength <= maximumBytes; next = this.outbound[0]) {
      frames.push(next);
      length += 2 + next.byteLength;
      this.outbound.shift();
    }
    return encodeFrameRecords(frames);
  }

  poll(): number | undefined {
    this.#check();
    return this.delay;
  }

  open(port: number): RouterOpen {
    this.#check();
    if ([...this.states.values()].length >= 64) return { kind: "busy" };
    this.opened.push(port);
    this.#next += 1;
    this.states.set(this.#next, "opening");
    return { kind: "opening", id: this.#next };
  }

  status(id: number): RouterConnectionStatus {
    this.#check();
    const state = this.states.get(id) ?? "closed";
    const readable = state === "connected" && (this.inbound.get(id)?.length ?? 0) > 0;
    return { state, readable, writable: state === "connected" && this.sendRoom > 0 };
  }

  send(id: number, bytes: Uint8Array): number {
    this.#check();
    const accepted = Math.min(bytes.byteLength, this.sendRoom);
    this.sent.set(id, [...(this.sent.get(id) ?? []), ...bytes.subarray(0, accepted)]);
    return accepted;
  }

  receive(id: number, maximumBytes: number): Uint8Array<ArrayBuffer> {
    this.#check();
    const waiting = this.inbound.get(id) ?? [];
    const taken = waiting.splice(0, maximumBytes);
    return Uint8Array.from(taken);
  }

  close(id: number): void {
    this.#check();
    this.closed.push(id);
    this.states.delete(id);
  }

  counters(): Uint8Array<ArrayBuffer> {
    this.#check();
    return this.record.slice();
  }

  #check(): void {
    if (this.trap) throw new VMError("RELAY_ERROR", "the router trapped", { reason: "trap" });
  }
}

/** Timers the test runs by moving the clock. */
class FakeClock {
  now = 0;
  #timers: { at: number; run: () => void }[] = [];
  get timers(): number { return this.#timers.length; }

  readonly setTimer = (run: () => void, ms: number): (() => void) => {
    const timer = { at: this.now + ms, run };
    this.#timers.push(timer);
    return () => { this.#timers = this.#timers.filter((other) => other !== timer); };
  };

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.#timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((timer) => timer !== due);
      this.now = Math.max(this.now, due.at);
      due.run();
    }
    this.now = until;
  }
}

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const resource of opened.splice(0)) resource.close();
});

async function turn(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function started(router = new FakeRouter(), load?: () => Promise<NetstackRouterApi>) {
  const clock = new FakeClock();
  const bridge = createFrameBridgeBuffer();
  const { port1: control, port2: doorbell } = new MessageChannel();
  const replies: unknown[] = [];
  control.onmessage = (event: MessageEvent) => { replies.push(event.data); };
  opened.push(control);
  const connection: NetworkLinkConnection = {
    version: PROTOCOL_VERSION,
    type: "connect-link",
    bridge,
    doorbell,
    netstackWasmUrl: "https://ide.example.test/oxidevm_netstack.wasm",
  };
  const netstack = await NetstackConnections.start(connection, {
    load: load ?? (() => Promise.resolve(router)),
    now: () => clock.now,
    seed: () => 7n,
    setTimer: clock.setTimer,
  });
  opened.push({ close: () => { netstack.dispose(); } });
  const ring = (): void => {
    control.postMessage({ version: 1, type: "frames", generation: frameBridgeGeneration(bridge) });
  };
  return {
    netstack, router, clock, bridge, replies, ring,
    toRouter: new FrameRing(bridge, "to-router"),
    toLinux: new FrameRing(bridge, "to-linux"),
  };
}

/** Opens `port` and lets the router report the connection connected. */
async function connected(setup: Awaited<ReturnType<typeof started>>, port = 3_000): Promise<RouterConnection> {
  const opening = setup.netstack.open(port);
  setup.router.states.set(setup.router.opened.length, "connected");
  setup.clock.advance(5);
  const result = await opening;
  if (result.kind !== "connected") throw new Error(`expected a connection, got ${result.kind}`);
  return result.connection;
}

function codeOf(error: unknown): string {
  return error instanceof VMError ? error.code : "not a VMError";
}

describe("starting the router", () => {
  it("reports ready, acknowledges the current generation and publishes its counters", async () => {
    const { replies, bridge, router } = await started();
    await vi.waitFor(() => { expect(replies).toEqual([{ version: 1, type: "router-ready" }]); });
    expect(routerGeneration(bridge)).toBe(frameBridgeGeneration(bridge));
    expect(readRouterCounters(bridge)).toEqual(router.record);
  });

  it("posts router-failed with the load reason when loading fails", async () => {
    const replies: unknown[] = [];
    const { port1: control, port2: doorbell } = new MessageChannel();
    control.onmessage = (event: MessageEvent) => { replies.push(event.data); };
    opened.push(control);
    const failure = new VMError("CORE_LOAD_FAILED", "offline", { component: "netstack", reason: "fetch" });
    const connection: NetworkLinkConnection = {
      version: PROTOCOL_VERSION, type: "connect-link", bridge: createFrameBridgeBuffer(), doorbell,
      netstackWasmUrl: "https://ide.example.test/oxidevm_netstack.wasm",
    };
    await expect(NetstackConnections.start(connection, { load: () => Promise.reject(failure) })).rejects.toBe(failure);
    await vi.waitFor(() => { expect(replies).toEqual([{ version: 1, type: "router-failed", reason: "fetch" }]); });
  });
});

describe("opening connections", () => {
  it("resolves connected when the router reports it", async () => {
    const setup = await started();
    const connection = await connected(setup);
    expect(connection.id).toBe(1);
    expect(setup.router.opened).toEqual([3_000]);
  });

  it.each(["refused", "timed-out"] as const)("resolves %s and closes the attempt's id", async (state) => {
    const setup = await started();
    const opening = setup.netstack.open(3_000);
    setup.router.states.set(1, state);
    setup.clock.advance(5);
    await expect(opening).resolves.toEqual({ kind: state });
    expect(setup.router.closed).toEqual([1]);
  });

  it("resolves busy at once when the router holds 64 connections", async () => {
    const setup = await started();
    // The 64 attempts stay pending; disposing the link at the end rejects them.
    for (let index = 0; index < 64; index += 1) void setup.netstack.open(3_000).catch(() => undefined);
    await expect(setup.netstack.open(3_000)).resolves.toEqual({ kind: "busy" });
  });

  it("refuses an invalid port and an aborted signal", async () => {
    const { netstack } = await started();
    await expect(netstack.open(0)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(netstack.open(65_536)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(netstack.open(3_000, AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("closes an attempt whose signal aborts and rejects ABORTED", async () => {
    const setup = await started();
    const controller = new AbortController();
    const opening = setup.netstack.open(3_000, controller.signal);
    controller.abort();
    await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
    expect(setup.router.closed).toEqual([1]);
  });
});

describe("reading and writing", () => {
  it("waits for router readiness without a retry timer or consuming response bytes", async () => {
    const setup = await started(), connection = await connected(setup);
    const before = setup.clock.timers;
    const waiting = connection.wait("read", new AbortController().signal);
    expect(setup.clock.timers).toBe(before);
    setup.router.inbound.set(connection.id, [9]); setup.ring();
    await waiting;
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(9) });
    setup.router.sendRoom = 0;
    const writable = connection.wait("write", new AbortController().signal);
    setup.router.sendRoom = 1; setup.ring(); await writable;
  });

  it("cancels readiness waits and retires remaining waiters when the connection closes", async () => {
    const setup = await started(), connection = await connected(setup), controller = new AbortController();
    const waiting = connection.wait("read", controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort(); await rejected;
    const closing = connection.wait("read", new AbortController().signal);
    connection.close(); await closing;
  });
  it("reads data at once, waits up to waitMs for more, then answers blocked", async () => {
    const setup = await started();
    const connection = await connected(setup);
    setup.router.inbound.set(1, [1, 2, 3]);
    await expect(connection.read(2, 0)).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(1, 2) });
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(3) });
    const waiting = connection.read(64, 25);
    setup.clock.advance(24);
    setup.router.inbound.set(1, [4]);
    setup.clock.advance(1);
    await expect(waiting).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(4) });
    const blocked = connection.read(64, 25);
    setup.clock.advance(25);
    await expect(blocked).resolves.toEqual({ kind: "blocked" });
  });

  it("wakes a waiting read when frames arrive from Linux", async () => {
    const setup = await started();
    const connection = await connected(setup);
    const waiting = connection.read(64, 10_000);
    setup.router.inbound.set(1, [9]);
    setup.ring();
    await expect(waiting).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(9) });
  });

  it("answers eof once Linux closed its end", async () => {
    const setup = await started();
    const connection = await connected(setup);
    setup.router.states.set(1, "peer-closed");
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "eof" });
  });

  it("writes what the send buffer takes", async () => {
    const setup = await started();
    const connection = await connected(setup);
    setup.router.sendRoom = 3;
    expect(connection.write(Uint8Array.of(1, 2, 3, 4))).toBe(3);
    expect(setup.router.sent.get(1)).toEqual([1, 2, 3]);
  });

  it("validates read sizes and waits", async () => {
    const setup = await started();
    const connection = await connected(setup);
    for (const [maximum, wait] of [[0, 0], [256 * 1024 + 1, 0], [1, -1], [1, 60_001], [1.5, 0]]) {
      await expect(connection.read(maximum ?? 1, wait ?? 0)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("rejects an aborted read with ABORTED and keeps the connection usable", async () => {
    const setup = await started();
    const connection = await connected(setup);
    const controller = new AbortController();
    const waiting = connection.read(64, 10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "ABORTED" });
    setup.router.inbound.set(1, [5]);
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(5) });
  });

  it("closes once, however often it is closed", async () => {
    const setup = await started();
    const connection = await connected(setup);
    connection.close();
    connection.close();
    expect(setup.router.closed).toEqual([1]);
    expect(connection.write(Uint8Array.of(1))).toBe(0);
  });
});

describe("the frame bridge", () => {
  it("drains the to-router ring into the router when control rings", async () => {
    const setup = await started();
    setup.toRouter.write(encodeFrameRecords([new Uint8Array(60).fill(1), new Uint8Array(70).fill(2)]));
    setup.ring();
    await vi.waitFor(() => { expect(setup.router.framesSeen.map((frame) => frame.byteLength)).toEqual([60, 70]); });
    expect(setup.toRouter.usedBytes()).toBe(0);
  });

  it("flushes the router's frames into the to-Linux ring and retries leftovers after 4 ms", async () => {
    const setup = await started();
    // Leave 1,600 bytes free: one 1,002-byte record fits, then the ring lacks room for a whole frame.
    Atomics.store(new Int32Array(setup.bridge, 0, 16), FRAME_BRIDGE_WORD.toLinuxHead, FRAME_BRIDGE_RING_BYTES - 1_600);
    setup.router.delay = undefined;
    setup.router.outbound.push(new Uint8Array(1_000).fill(1), new Uint8Array(1_000).fill(2));
    setup.ring();
    await vi.waitFor(() => { expect(setup.router.outbound).toHaveLength(1); });
    setup.toLinux.advance(FRAME_BRIDGE_RING_BYTES - 1_600 + 1_002);
    setup.clock.advance(4);
    expect(setup.router.outbound).toHaveLength(0);
    expect(setup.toLinux.usedBytes()).toBe(1_002);
  });

  it("starts over for a new generation: router re-initialised, stale records skipped, opens refused, connections reset", async () => {
    const setup = await started();
    const connection = await connected(setup);
    const opening = setup.netstack.open(4_000);
    advanceFrameBridgeGeneration(setup.bridge);
    setup.toRouter.write(encodeFrameRecords([new Uint8Array(60)]));
    setup.ring();
    await vi.waitFor(() => { expect(setup.router.inits).toEqual([7n]); });
    expect(setup.router.framesSeen).toEqual([]);
    expect(routerGeneration(setup.bridge)).toBe(1);
    await expect(opening).resolves.toEqual({ kind: "refused" });
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "reset" });
    expect(connection.write(Uint8Array.of(1))).toBe(0);
  });

  it("publishes the router's counters at most every 250 ms", async () => {
    const setup = await started();
    setup.router.record[0] = 0xaa;
    setup.ring();
    await turn();
    expect(readRouterCounters(setup.bridge)?.[0]).toBe(0);
    setup.clock.advance(250);
    setup.ring();
    await turn();
    expect(readRouterCounters(setup.bridge)?.[0]).toBe(0xaa);
  });
});

describe("a router that traps", () => {
  it("resets connections, posts router-failed, and fails later opens with RELAY_ERROR", async () => {
    const setup = await started();
    const connection = await connected(setup);
    const waiting = setup.netstack.open(4_000).then((result: RouterOpenResult) => result.kind, codeOf);
    setup.router.trap = true;
    setup.ring();
    await vi.waitFor(() => { expect(setup.replies).toContainEqual({ version: 1, type: "router-failed", reason: "trap" }); });
    await expect(connection.read(64, 0)).resolves.toEqual({ kind: "reset" });
    await expect(waiting).resolves.toBe("RELAY_ERROR");
    await expect(setup.netstack.open(3_000)).rejects.toMatchObject({ code: "RELAY_ERROR" });
  });
});
