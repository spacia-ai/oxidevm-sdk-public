import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../../errors.js";
import {
  clearFrameBridgeKick,
  createFrameBridgeBuffer,
  encodeFrameRecords,
  FRAME_BRIDGE_RING_BYTES,
  FRAME_BRIDGE_WORD,
  frameBridgeGeneration,
  FrameRing,
  publishRouterCounters,
  publishRouterGeneration,
} from "../../frame-bridge.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { CORE_API_VERSION, createCore, type Core } from "./core.js";
import { NetworkLink } from "./network-link.js";

/** A 60-byte frame whose byte 20 names it. */
function frame(name: number, length = 60): Uint8Array {
  const bytes = new Uint8Array(length).fill(0x5a);
  bytes[20] = name;
  return bytes;
}

/** A core whose network card accepts `capacity` records per give and transmits `transmit`. */
function linkCore() {
  const memory = new WebAssembly.Memory({ initial: 16 });
  const bytes = () => new Uint8Array(memory.buffer);
  const state = { capacity: 256, given: [] as Uint8Array[], transmit: [] as Uint8Array[], attached: 0, giveResult: undefined as number | undefined };
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_network_attach: () => {
      state.attached += 1;
      return 0;
    },
    oxidevm_system_network_give: (length: number) => {
      if (state.giveResult !== undefined) return state.giveResult;
      const records = bytes().slice(0, length);
      let offset = 0;
      let accepted = 0;
      while (offset < length && accepted < state.capacity) {
        const size = (records[offset] ?? 0) | ((records[offset + 1] ?? 0) << 8);
        state.given.push(records.slice(offset + 2, offset + 2 + size));
        offset += 2 + size;
        accepted += 1;
      }
      return accepted;
    },
    oxidevm_system_network_counters: () => {
      const record = new Uint8Array(168);
      const view = new DataView(record.buffer);
      view.setUint32(0, 1, true);
      view.setUint32(4, state.attached > 0 ? 1 : 0, true);
      bytes().set(record, 0);
      return record.byteLength;
    },
    oxidevm_system_network_take: (maximum: number) => {
      let length = 0;
      while (state.transmit.length > 0) {
        const next = state.transmit[0];
        if (next === undefined || length + 2 + next.byteLength > maximum) break;
        bytes().set(encodeFrameRecords([next]), length);
        length += 2 + next.byteLength;
        state.transmit.shift();
      }
      return length;
    },
  };
  const core: Core = createCore(new Proxy(functions, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return target[key] ?? (() => 0);
    },
  }), memory, "network-link-test", JIT_CACHE_BYTES);
  return { core, state };
}

/** A link whose router answered ready, plus the network worker's side of the bridge. */
async function connectedLink() {
  const bridge = createFrameBridgeBuffer();
  const { port1, port2 } = new MessageChannel();
  const notices: unknown[] = [];
  port2.onmessage = (event: MessageEvent) => {
    notices.push(event.data);
  };
  port2.postMessage({ version: 1, type: "router-ready" });
  const link = await NetworkLink.connect(bridge, port1, 5_000);
  const network = {
    toLinux: new FrameRing(bridge, "to-linux"),
    toRouter: new FrameRing(bridge, "to-router"),
    /** The router initialised itself for the current generation. */
    acknowledge: () => { publishRouterGeneration(bridge, frameBridgeGeneration(bridge)); },
    notices,
    port: port2,
  };
  return { link, bridge, network };
}

const opened: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const port of opened.splice(0)) port.close();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe("connecting to the router", () => {
  it("resolves once the network worker's router is ready", async () => {
    const { link, network } = await connectedLink();
    opened.push(network.port);
    expect(link.state).toBe("detached");
    link.close();
  });

  it.each(["fetch", "init"] as const)("fails with CORE_LOAD_FAILED when the router reports %s", async (reason) => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port2);
    port2.postMessage({ version: 1, type: "router-failed", reason });
    await expect(NetworkLink.connect(createFrameBridgeBuffer(), port1, 5_000))
      .rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason } });
  });

  it("fails with CORE_LOAD_FAILED when the router never answers", async () => {
    vi.useFakeTimers();
    const { port1, port2 } = new MessageChannel();
    opened.push(port2);
    const connecting = NetworkLink.connect(createFrameBridgeBuffer(), port1, 1_000);
    const outcome = expect(connecting).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "timeout" } });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });
});

describe("moving frames around a core step", () => {
  it("advances the to-Linux ring exactly past the records the core accepted and gives the rest first at the next step", async () => {
    const { core, state } = linkCore();
    const { link, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    network.toLinux.write(encodeFrameRecords([frame(1), frame(2), frame(3)]));
    state.capacity = 2;
    link.beforeStep(core);
    expect(state.given.map((given) => given[20])).toEqual([1, 2]);
    expect(network.toLinux.usedBytes()).toBe(62);
    state.capacity = 10;
    link.beforeStep(core);
    expect(state.given.map((given) => given[20])).toEqual([1, 2, 3]);
    expect(network.toLinux.usedBytes()).toBe(0);
    link.close();
  });

  it("attaches the card, advances the generation, drops records meant for the old machine and rings once", async () => {
    const { core, state } = linkCore();
    const { link, bridge, network } = await connectedLink();
    opened.push(network.port);
    network.toLinux.write(encodeFrameRecords([frame(9)]));
    link.machineReplaced(core);
    expect(state.attached).toBe(1);
    expect(link.state).toBe("attached");
    expect(frameBridgeGeneration(bridge)).toBe(1);
    expect(network.toLinux.usedBytes()).toBe(0);
    await settle();
    expect(network.notices).toEqual([{ version: 1, type: "frames", generation: 1 }]);
    link.close();
  });

  it("gives Linux nothing until the router has started over for the new machine", async () => {
    const { core, state } = linkCore();
    const { link, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.toLinux.write(encodeFrameRecords([frame(1)]));
    link.beforeStep(core);
    expect(state.given).toEqual([]);
    expect(network.toLinux.usedBytes()).toBe(0);
    network.acknowledge();
    network.toLinux.write(encodeFrameRecords([frame(2)]));
    link.beforeStep(core);
    expect(state.given.map((given) => given[20])).toEqual([2]);
    link.close();
  });

  it("takes what Linux sent into the to-router ring within its free space, ringing once per batch", async () => {
    const { core, state } = linkCore();
    const { link, bridge, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    await settle();
    clearFrameBridgeKick(bridge);
    network.notices.length = 0;
    // Only 1,000 bytes stay free: one 602-byte record fits, the next does not.
    Atomics.store(new Int32Array(bridge, 0, 16), FRAME_BRIDGE_WORD.toRouterHead, FRAME_BRIDGE_RING_BYTES - 1_000);
    state.transmit.push(frame(1, 600), frame(2, 600), frame(3, 600));
    link.afterStep(core);
    expect(state.transmit.map((next) => next[20])).toEqual([2, 3]);
    network.toRouter.advance(FRAME_BRIDGE_RING_BYTES - 1_000);
    const out = new Uint8Array(4096);
    expect(network.toRouter.peek(out).recordEnds).toEqual([602]);
    expect(out[22]).toBe(1);
    network.toRouter.advance(602);
    link.afterStep(core);
    expect(state.transmit).toEqual([]);
    await settle();
    expect(network.notices).toHaveLength(1);
    link.close();
  });

  it("moves frames both ways on an idle turn with no instructions between", async () => {
    const { core, state } = linkCore();
    const { link, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    network.toLinux.write(encodeFrameRecords([frame(4)]));
    state.transmit.push(frame(5));
    link.beforeStep(core);
    link.afterStep(core);
    expect(state.given.map((given) => given[20])).toEqual([4]);
    expect(network.toRouter.usedBytes()).toBe(62);
    link.close();
  });

  it("explicitly attaches user-supplied guests and detaches at a new generation", async () => {
    const { core, state } = linkCore();
    const { link, bridge, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    expect([state.attached, frameBridgeGeneration(bridge), link.state]).toEqual([1, 1, "attached"]);
    network.toLinux.write(encodeFrameRecords([frame(1)]));
    state.transmit.push(frame(2));
    link.beforeStep(core);
    link.afterStep(core);
    expect([state.given, state.transmit.length, network.toRouter.usedBytes()]).toEqual([[expect.any(Uint8Array)], 0, 62]);
    link.detach();
    expect(frameBridgeGeneration(bridge)).toBe(2);
    link.close();
  });

  it("fails the link, not the VM, when the router leaves an invalid record for Linux", async () => {
    const { core } = linkCore();
    const { link, bridge, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    Atomics.store(new Int32Array(bridge, 0, 16), FRAME_BRIDGE_WORD.toLinuxHead, 20);
    expect(() => { link.beforeStep(core); }).not.toThrow();
    expect(link.state).toBe("failed");
    link.close();
  });

  it("raises VM_FAULT when the core reports an impossible frame count", async () => {
    const { core, state } = linkCore();
    const { link, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    network.toLinux.write(encodeFrameRecords([frame(1)]));
    for (const impossible of [2, -1]) {
      state.giveResult = impossible;
      let caught: unknown;
      try {
        link.beforeStep(core);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VMError);
      expect(caught).toMatchObject({ code: "VM_FAULT" });
    }
    link.close();
  });

  it("fails the link when the router reports a trap after it was ready", async () => {
    const { core } = linkCore();
    const { link, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.port.postMessage({ version: 1, type: "router-failed", reason: "trap" });
    await settle();
    await settle();
    expect(link.state).toBe("failed");
    link.close();
  });
});

describe("diagnostics", () => {
  /** A router counter record with every count zero, which reconciles. */
  function routerRecord(): Uint8Array {
    const record = new Uint8Array(352);
    const view = new DataView(record.buffer);
    view.setUint32(0, 2, true);
    view.setUint32(4, 43, true);
    return record;
  }

  it("read the core counters and the router counters the network worker published", async () => {
    const { core, state } = linkCore();
    const { link, bridge, network } = await connectedLink();
    opened.push(network.port);
    link.machineReplaced(core);
    network.acknowledge();
    network.toLinux.write(encodeFrameRecords([frame(1)]));
    link.beforeStep(core);
    expect(state.given).toHaveLength(1);
    expect(link.diagnostics(core)).toMatchObject({
      link: "attached", failure: null, generation: 1, core: { backend: "host-link" }, router: null,
      bridge: { givenFrames: 1, givenBytes: 60, takenFrames: 0, kicks: 1 },
    });
    publishRouterCounters(bridge, routerRecord());
    expect(link.diagnostics(core).router).toMatchObject({ framesIn: 0n, framingErrors: 0n });
    link.close();
  });

  it("describe a VM without the link by its core alone", () => {
    const { core } = linkCore();
    expect(NetworkLink.absent(core)).toEqual({
      link: "absent",
      failure: null,
      generation: 0,
      bridge: { givenFrames: 0, givenBytes: 0, takenFrames: 0, takenBytes: 0, giveBackpressure: 0, takeRingFull: 0, kicks: 0 },
      core: expect.objectContaining({ backend: "test-responder" }) as unknown,
      router: null,
    });
  });
});
