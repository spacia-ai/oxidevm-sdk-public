import { createFrameTransport, type FrameTransport } from "../../frame-transport.js";
// The control worker's end of the full-system network link (ADR 0015). Around every core step it
// gives the network card the router's frames for Linux and takes the frames Linux transmitted,
// through the shared frame bridge, and rings the network worker's doorbell for new frames. A
// replaced machine advances the bridge generation, so the router starts over and frames meant for
// the old machine never reach the new one.
import { decodeCoreNetworkCounters, type CoreNetworkCounters } from "../../core-abi/network.js";
import { VMError } from "../../errors.js";
import { decodeNetstackCounters } from "../../netstack-abi.js";
import type { SystemTraceNetworkProfile } from "../../protocol/system-trace-network.js";
import {
  decodeFrameBridgeReply,
  type FrameBridgeReply,
  frameRecordEnds,
  MAX_FRAME_BYTES,
  type RouterFailure,
} from "../../frame-bridge.js";
import { callNumber, type Core, memorySlice, stage } from "./core.js";

/** How long the network worker may take to load and start the router. */
export const NETWORK_LINK_CONNECT_TIMEOUT_MS = 30_000;
/** Bytes of records moved per give or take. */
const BATCH_BYTES = 256 * 1024;
/** The smallest frame record: a length and an Ethernet header. */
const MIN_RECORD_BYTES = 16;

export type NetworkLinkState = "detached" | "attached" | "failed";
export type NetworkLinkFailure = "worker" | "protocol" | "timeout" | RouterFailure;

export interface NetworkLinkStats {
  givenFrames: number;
  givenBytes: number;
  takenFrames: number;
  takenBytes: number;
  /** Gives the card stopped short of everything waiting for Linux. */
  giveBackpressure: number;
  /** Takes that left the to-router ring without room for a whole frame. */
  takeRingFull: number;
  kicks: number;
}

export class NetworkLink {
  readonly #bridge: FrameTransport;
  readonly #port: MessagePort;
  readonly #toRouter: FrameTransport["toRouter"];
  readonly #toLinux: FrameTransport["toLinux"];
  readonly #scratch = new Uint8Array(BATCH_BYTES);
  readonly #stats: NetworkLinkStats = {
    givenFrames: 0,
    givenBytes: 0,
    takenFrames: 0,
    takenBytes: 0,
    giveBackpressure: 0,
    takeRingFull: 0,
    kicks: 0,
  };
  #state: NetworkLinkState = "detached";
  #failure: NetworkLinkFailure | null = null;
  #closed = false;

  private constructor(bridge: SharedArrayBuffer | "message", port: MessagePort) {
    this.#bridge = createFrameTransport(bridge, port, "control");
    this.#port = port;
    this.#toRouter = this.#bridge.toRouter;
    this.#toLinux = this.#bridge.toLinux;
  }

  /** Resolves once the network worker reports its router ready; a router that failed to start or
   * never answered rejects with CORE_LOAD_FAILED. */
  static connect(
    bridge: SharedArrayBuffer | "message",
    doorbell: MessagePort,
    timeoutMilliseconds = NETWORK_LINK_CONNECT_TIMEOUT_MS,
  ): Promise<NetworkLink> {
    const link = new NetworkLink(bridge, doorbell);
    return new Promise<NetworkLink>((resolve, reject) => {
      const refuse = (reason: NetworkLinkFailure): void => {
        clearTimeout(timer);
        link.close();
        reject(new VMError("CORE_LOAD_FAILED", `the network router did not start (${reason})`, { component: "netstack", reason }));
      };
      const timer = setTimeout(() => { refuse("timeout"); }, timeoutMilliseconds);
      let ready = false;
      doorbell.onmessage = (event: MessageEvent) => {
        try { if (link.#bridge.receive(event.data)) return; }
        catch { if (ready) link.failed("protocol"); else refuse("protocol"); return; }
        const reply = replyOf(event.data);
        if (reply === null) {
          if (ready) link.failed("protocol");
          else refuse("protocol");
          return;
        }
        if (reply.type === "router-failed") {
          if (ready) link.failed(reply.reason);
          else refuse(reply.reason);
        } else if (!ready) {
          ready = true;
          clearTimeout(timer);
          resolve(link);
        }
      };
    });
  }

  get state(): NetworkLinkState {
    return this.#state;
  }

  get failure(): NetworkLinkFailure | null {
    return this.#failure;
  }

  get generation(): number {
    return this.#bridge.generation;
  }

  get stats(): Readonly<NetworkLinkStats> {
    return { ...this.#stats };
  }

  /** The link for a live system trace: its state, the bridge counts, the core card's counters and
   * the router's last whole published counters (null before the first or while one is written). */
  diagnostics(loaded: Core): SystemTraceNetworkProfile {
    const published = this.#bridge.readCounters();
    return {
      link: this.#state,
      failure: this.#failure,
      generation: this.#bridge.generation,
      bridge: { ...this.#stats },
      core: readCoreNetworkCounters(loaded),
      router: published === undefined ? null : decodeNetstackCounters(published),
    };
  }

  /** A VM that never started the link: only its core card, on the test responder, has counters. */
  static absent(loaded: Core): SystemTraceNetworkProfile {
    return {
      link: "absent",
      failure: null,
      generation: 0,
      bridge: { givenFrames: 0, givenBytes: 0, takenFrames: 0, takenBytes: 0, giveBackpressure: 0, takeRingFull: 0, kicks: 0 },
      core: readCoreNetworkCounters(loaded),
      router: null,
    };
  }

  /** The control worker replaced the core's machine: a machine on the managed host disk gets the
   * host link, any other keeps the test responder. Either way the router starts over. */
  machineReplaced(loaded: Core): void {
    if (this.#closed) return;
    const attach = this.#state !== "failed";
    if (attach) {
      const status = callNumber(loaded, "oxidevm_system_network_attach");
      if (status !== 0) throw new VMError("VM_FAULT", `the network card refused the host link (status ${String(status)})`);
    }
    this.#replaced(attach ? "attached" : "detached");
  }

  attachExisting(loaded: Core): void {
    if (readCoreNetworkCounters(loaded) !== null) this.machineReplaced(loaded);
  }

  /** The machine is gone or replaced by one without the link. */
  detach(): void {
    if (this.#closed) return;
    this.#replaced("detached");
  }

  failed(reason: NetworkLinkFailure): void {
    this.#state = "failed";
    this.#failure = reason;
  }

  /** Gives the card the router's frames for Linux, oldest first, until it pushes back. */
  beforeStep(loaded: Core): void {
    if (this.#closed || this.#state !== "attached") return;
    this.#guardRing(() => {
      if (this.#bridge.routerGeneration !== this.#bridge.generation) {
        this.#toLinux.skipAll();
        return;
      }
      this.#give(loaded);
    });
  }

  /** Takes the frames Linux transmitted into the to-router ring and rings the doorbell once. */
  afterStep(loaded: Core): void {
    if (this.#closed || this.#state !== "attached") return;
    this.#guardRing(() => { this.#take(loaded); });
  }

  close(): void {
    this.#closed = true;
    this.#port.onmessage = null;
    this.#port.close();
  }

  #replaced(state: "attached" | "detached"): void {
    if (this.#state !== "failed") this.#state = state;
    this.#bridge.advanceGeneration();
    this.#guardRing(() => { this.#toLinux.skipAll(); });
    this.#ring();
  }

  #give(loaded: Core): void {
    for (;;) {
      const peek = this.#toLinux.peek(this.#scratch);
      if (peek.recordEnds.length === 0) return;
      stage(loaded, this.#scratch.subarray(0, peek.length));
      const accepted = callNumber(loaded, "oxidevm_system_network_give", [peek.length]);
      if (!Number.isInteger(accepted) || accepted < 0 || accepted > peek.recordEnds.length) {
        throw new VMError("VM_FAULT", `the network card accepted an impossible ${String(accepted)} frames`);
      }
      if (accepted === 0) {
        this.#stats.giveBackpressure += 1;
        return;
      }
      const consumed = peek.recordEnds[accepted - 1] ?? 0;
      this.#toLinux.advance(consumed);
      this.#stats.givenFrames += accepted;
      this.#stats.givenBytes += consumed - 2 * accepted;
      if (accepted < peek.recordEnds.length) {
        this.#stats.giveBackpressure += 1;
        return;
      }
    }
  }

  #take(loaded: Core): void {
    let wrote = false;
    for (let free = this.#toRouter.freeBytes(); free >= MIN_RECORD_BYTES; free = this.#toRouter.freeBytes()) {
      const maximum = Math.min(free, BATCH_BYTES);
      const length = callNumber(loaded, "oxidevm_system_network_take", [maximum]);
      if (length === 0) break;
      if (!Number.isInteger(length) || length < 0 || length > maximum) {
        throw new VMError("VM_FAULT", `the network card handed over an impossible ${String(length)} bytes`);
      }
      const records = memorySlice(loaded.memory, callNumber(loaded, "oxidevm_staging_ptr"), length);
      let frames: number;
      try {
        frames = frameRecordEnds(records).length;
      } catch {
        throw new VMError("VM_FAULT", "the network card handed over invalid frame records");
      }
      this.#toRouter.write(records);
      this.#stats.takenFrames += frames;
      this.#stats.takenBytes += length - 2 * frames;
      wrote = true;
    }
    if (this.#toRouter.freeBytes() < 2 + MAX_FRAME_BYTES) this.#stats.takeRingFull += 1;
    if (wrote) this.#ring();
  }

  #ring(): void {
    if (this.#bridge.ring()) this.#stats.kicks += 1;
  }

  /** A ring the network worker broke fails the link; the guest machine carries on. */
  #guardRing(run: () => void): void {
    try {
      run();
    } catch (error: unknown) {
      if (error instanceof VMError && error.code === "PROTOCOL_ERROR") {
        this.failed("protocol");
        return;
      }
      throw error;
    }
  }
}

/** The core network card's counters; null while the core holds no system machine. */
function readCoreNetworkCounters(loaded: Core): CoreNetworkCounters | null {
  const length = callNumber(loaded, "oxidevm_system_network_counters");
  if (length === 0) return null;
  return decodeCoreNetworkCounters(memorySlice(loaded.memory, callNumber(loaded, "oxidevm_staging_ptr"), length).slice());
}

/** The network worker's reply, or null for one that does not decode. */
function replyOf(data: unknown): FrameBridgeReply | null {
  try {
    return decodeFrameBridgeReply(data);
  } catch {
    return null;
  }
}
