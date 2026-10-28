import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentKind, type AgentFrame } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";
import { decodeListeningPortsMessage, type ListeningPortsMessage } from "../../protocol/listening-ports.js";
import type { ListeningPort } from "../../vm-types.js";
import type { AgentResumeState } from "./agent-resume-state.js";
import { scriptedGuest, type ScriptedGuest } from "./guest-agent.test-support.js";

const VECTORS = readFileSync(new URL("../../../../../../tests/fixtures/agent/listeners.hex", import.meta.url), "utf8");
const TODAY = 1 | 2 | 8 | 16 | 32;
const WATCHING = TODAY | 64;

/** The "typical" vector's listeners as the page receives them. */
const TYPICAL: readonly ListeningPort[] = [
  { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true },
  { port: 4000, address: "127.0.0.1", program: null, previewable: true },
  { port: 4001, address: "::1", program: "bun -e x", previewable: false },
  { port: 4002, address: "::ffff:127.0.0.1", program: "node server.js", previewable: true },
  { port: 5173, address: "::", program: "node vite", previewable: true },
];

function vector(name: string): Uint8Array<ArrayBuffer> {
  const line = VECTORS.split("\n").find((entry) => entry.startsWith(`${name} `));
  if (line === undefined) throw new Error(`vector ${name} is missing`);
  const hex = line.slice(name.length + 1);
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function event(requestId: number, payload: Uint8Array<ArrayBuffer> = vector("typical")): AgentFrame {
  return { version: 7, kind: AgentKind.listeners, requestId, status: 0, payload };
}

/** The WATCH_LISTENERS operations the host sent, in order: 1 subscribe, 2 unsubscribe. */
function watchOperations(guest: ScriptedGuest): number[] {
  return guest.received.filter((frame) => frame.kind === AgentKind.watchListeners).map((frame) => frame.payload[0] ?? 0);
}

function lastWatch(guest: ScriptedGuest): AgentFrame {
  const frame = guest.received.filter((entry) => entry.kind === AgentKind.watchListeners).at(-1);
  if (frame === undefined) throw new Error("no watch request was sent");
  return frame;
}

/** Lets replies settle: drains the agent between turns of the event loop, as a running session does. */
async function settle(guest: ScriptedGuest): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    guest.drain();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

/** A page's end of the watch port, collecting what the control worker posts. */
function page() {
  const channel = new MessageChannel();
  const messages: ListeningPortsMessage[] = [];
  channel.port2.onmessage = (message: MessageEvent<unknown>) => { messages.push(decodeListeningPortsMessage(message.data)); };
  return { port: channel.port1, messages, close: () => { channel.port2.close(); } };
}

function restored(capabilities: number, nextRequestId: number): AgentResumeState {
  return {
    dialect: 7, capabilities, nextRequestId, inbound: new Uint8Array(), inboundSkip: 0, inboundLost: false,
    outbound: new Uint8Array(), outboundSequence: 0, processes: [], consoleTail: new Uint8Array(),
  };
}

const pages: { close(): void }[] = [];
afterEach(() => {
  for (const opened of pages.splice(0)) opened.close();
});

function watchingPage() {
  const opened = page();
  pages.push(opened);
  return opened;
}

describe("the guest's listening ports in System", () => {
  it("answers image-update-required and never sends watch-listeners to an agent without capability 64", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: TODAY });
    const early = watchingPage();
    guest.agent.listenerWatch.watch(early.port);
    await guest.agent.wait(1, 1000);
    await vi.waitFor(() => { expect(early.messages).toHaveLength(1); });
    expect(early.messages[0]).toMatchObject({ type: "failed", error: { code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } } });
    const late = watchingPage();
    expect(thrown(() => { guest.agent.listenerWatch.watch(late.port); })).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
    await expect(guest.agent.listenerWatch.list()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
    expect(guest.received.every((frame) => frame.kind !== AgentKind.watchListeners)).toBe(true);
  });

  it("subscribes an agent with capability 64, delivers previewable lists, and unsubscribes after the page stops", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    expect(watchOperations(guest)).toEqual([1]);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages).toEqual([{ type: "ports", ports: TYPICAL }]); });
    guest.agent.listenerWatch.unwatch();
    await settle(guest);
    expect(watchOperations(guest)).toEqual([1, 2]);
    expect(guest.agent.listenerWatch.draining).toBe(false);
  });

  it("keeps draining agent output while a listener subscription is open with nothing else pending", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    expect(guest.agent.listenerWatch.draining).toBe(true);
    guest.send(event(lastWatch(guest).requestId));
    guest.drain();
    await vi.waitFor(() => { expect(watching.messages).toHaveLength(1); });
  });

  it("drops events of a subscription captured in a restore point and ends it when nobody watches", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING, ready: false });
    guest.agent.resume(guest.core, restored(WATCHING, 50));
    const dropped = guest.agent.droppedFrames;
    guest.send(event(10));
    expect(() => { guest.drain(); }).not.toThrow();
    // Nothing is pending before the greeting, so the frame waits for the greeting's drain.
    await guest.agent.wait(1, 1000);
    expect(guest.agent.droppedFrames).toBe(dropped + 1);
    guest.session.active = true;
    await settle(guest);
    expect(watchOperations(guest)).toEqual([2]);
    expect(lastWatch(guest).requestId).toBeGreaterThanOrEqual(50);
  });

  it("re-subscribes after a resume when a page watches", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages).toHaveLength(1); });
    const floor = lastWatch(guest).requestId + 5;
    guest.agent.resume(guest.core, restored(WATCHING, floor));
    await vi.waitFor(() => { expect(watching.messages.at(-1)).toEqual({ type: "ports", ports: [] }); });
    // The restore flow greets the restored agent before the session runs again.
    guest.session.active = false;
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    await settle(guest);
    expect(watchOperations(guest)).toEqual([1, 1]);
    expect(lastWatch(guest).requestId).toBeGreaterThanOrEqual(floor);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages.at(-1)).toEqual({ type: "ports", ports: TYPICAL }); });
  });

  it("posts an empty list and re-subscribes after the agent restarts", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages).toHaveLength(1); });
    guest.send({ version: 7, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages.at(-1)).toEqual({ type: "ports", ports: [] }); });
    expect(guest.received.filter((frame) => frame.kind === AgentKind.hello)).toHaveLength(2);
    expect(watchOperations(guest)).toEqual([1, 1]);
    expect(guest.agent.supportsListeners).toBe(true);
  });

  it("rejects a listener event for a subscription it never opened", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    guest.send(event(lastWatch(guest).requestId + 100));
    expect(() => { guest.drain(); }).toThrow(VMError);
    expect(watching.messages).toEqual([]);
  });

  it("refuses a listener event from an agent without capability 64", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: TODAY });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const pending = guest.agent.readFile(2, "/etc/hostname").catch(() => undefined);
    guest.send(event(1));
    expect(thrown(() => { guest.drain(); })).toMatchObject({ code: "PROTOCOL_ERROR" });
    await pending;
  });

  it("lists agent-not-ready before the greeting, the latest list while watched, and a one-shot list otherwise", async () => {
    const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
    await expect(guest.agent.listenerWatch.list()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "agent-not-ready" } });
    await guest.agent.wait(1, 1000);
    guest.session.active = true;
    const once = guest.agent.listenerWatch.list();
    await settle(guest);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await expect(once).resolves.toEqual(TYPICAL);
    await settle(guest);
    expect(watchOperations(guest)).toEqual([1, 2]);
    const watching = watchingPage();
    guest.agent.listenerWatch.watch(watching.port);
    await settle(guest);
    guest.send(event(lastWatch(guest).requestId));
    await settle(guest);
    await vi.waitFor(() => { expect(watching.messages).toHaveLength(1); });
    await expect(guest.agent.listenerWatch.list()).resolves.toEqual(TYPICAL);
    expect(watchOperations(guest)).toEqual([1, 2, 1]);
  });

  it("fails a one-shot list the guest does not answer within 10 s", async () => {
    vi.useFakeTimers();
    try {
      const guest = scriptedGuest({ version: 7, capabilities: WATCHING });
      await guest.agent.wait(1, 1000);
      guest.session.active = true;
      const once = guest.agent.listenerWatch.list();
      const outcome = once.then(() => "listed", (error: unknown) => error);
      guest.drain();
      await vi.advanceTimersByTimeAsync(9_999);
      guest.drain();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: "GUEST_CRASH", detail: { reason: "listeners-timeout" } });
      guest.drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(watchOperations(guest)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
