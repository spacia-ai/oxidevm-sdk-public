import { afterEach, describe, expect, it, vi } from "vitest";

import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { AgentKind, AgentPayloadWriter, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { CORE_API_VERSION, createCore } from "./core.js";
import { GuestAgent } from "./guest-agent.js";

const channels: MessageChannel[] = [];

/** A guest agent at the other end of hvc1: it answers HELLO and replays queued output bytes. */
function guest() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const output: Uint8Array[] = [];
  const requests: number[] = [];
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_agent_input: (length: number) => {
      const view = new DataView(memory.buffer);
      const kind = view.getUint16(6, true);
      requests.push(kind);
      if (kind === AgentKind.hello) {
        send({ version: 7, kind: kind | 0x8000, requestId: view.getUint32(8, true), status: 0,
          payload: new AgentPayloadWriter().string("resume-test").u32(3 | 32).finish() });
      }
      if (kind === AgentKind.setTime || kind === AgentKind.reseedEntropy) {
        send({ version: 7, kind: kind | 0x8000, requestId: view.getUint32(8, true), status: 0, payload: new Uint8Array() });
      }
      return length;
    },
    oxidevm_system_agent_output: () => {
      const bytes = output.shift();
      if (bytes === undefined) return 0;
      new Uint8Array(memory.buffer).set(bytes);
      return bytes.length;
    },
  };
  const core = createCore(new Proxy(functions, { get(target, key) {
    if (typeof key === "string" && key in target) return target[key];
    return () => 0;
  } }), memory, "resume-test", JIT_CACHE_BYTES);
  function send(frame: AgentFrame): void {
    // The encoder refuses request id 0, which READY carries; patch it into the header.
    const bytes = encodeAgentFrame({ ...frame, requestId: frame.requestId || 1 });
    new DataView(bytes.buffer).setUint32(8, frame.requestId, true);
    output.push(bytes);
  }
  function sendBytes(bytes: Uint8Array): void {
    output.push(bytes);
  }
  const agent = (): GuestAgent => {
    const created: GuestAgent = new GuestAgent(
      () => {
        created.flushInput(core);
        created.drainOutput(core);
        return Promise.resolve(undefined);
      },
      () => undefined,
      () => undefined,
      () => "",
      () => ({ active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" as const }),
      () => undefined,
    );
    return created;
  };
  return { core, send, sendBytes, requests, agent };
}

function stdout(requestId: number, pid: number, text: string): AgentFrame {
  return { version: 7, kind: AgentKind.stdout, requestId, status: 0, payload: new AgentPayloadWriter().u32(pid).bytesRaw(new TextEncoder().encode(text)).finish() };
}

function port(sessionId = 1) {
  const channel = new MessageChannel();
  channels.push(channel);
  const events: unknown[] = [];
  channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => events.push(event.data));
  channel.port2.start();
  const ack = (sequence: number) => channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId, type: "output-ack", sequence });
  return { host: channel.port1, events, ack };
}

async function booted(side: ReturnType<typeof guest>): Promise<GuestAgent> {
  const agent = side.agent();
  agent.activate(side.core);
  side.send({ version: 7, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  await agent.wait(1, 1000);
  return agent;
}

describe("guest agent resume", () => {
  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("greets a resumed agent without waiting for READY and drops replies from before the cut", async () => {
    const side = guest();
    const before = await booted(side);
    const state = before.resumeState(new Uint8Array());
    expect(state).toMatchObject({ dialect: 7, capabilities: 3 | 32, nextRequestId: 2 });

    const resumed = side.agent();
    resumed.resume(side.core, state);
    side.send({ version: 7, kind: AgentKind.readFile | 0x8000, requestId: 1, status: 0, payload: new Uint8Array() });
    const hello = await resumed.wait(2, 1000);

    expect(hello.capabilities).toEqual({ files: true, processes: true });
    expect(resumed.droppedFrames).toBe(1);
  });

  it("reseeds entropy and then steps the clock through a resumed agent after greeting it", async () => {
    const side = guest();
    const before = await booted(side);
    const resumed = side.agent();
    resumed.resume(side.core, before.resumeState(new Uint8Array()));
    await resumed.wait(2, 1000);
    side.requests.length = 0;

    await resumed.refreshGuest(3);

    expect(side.requests).toEqual([AgentKind.reseedEntropy, AgentKind.setTime]);
  });

  it("delivers a process output frame split across the cut to the page that attaches", async () => {
    const side = guest();
    const before = await booted(side);
    const process = { agentRequestId: 1, pid: 42, terminal: true, stdinOpen: true, command: "sh", tail: new TextEncoder().encode("$ ") };
    // A restored session relaying process 42 reads half of its next output frame before the cut.
    const live = side.agent();
    live.resume(side.core, { ...before.resumeState(new Uint8Array()), processes: [process] });
    const wire = encodeAgentFrame(stdout(1, 42, "ready\r\n"));
    side.sendBytes(wire.subarray(0, 9));
    live.drainOutput(side.core);
    const captured = live.resumeState(new Uint8Array());
    expect(captured.inbound).toEqual(wire.subarray(0, 9));
    expect(captured.processes).toEqual([process]);

    const resumed = side.agent();
    resumed.resume(side.core, captured);
    const { host, events, ack } = port();
    expect(resumed.attach(1, host)).toEqual({ pid: 42, sessionId: 1, terminal: true });
    side.sendBytes(wire.subarray(9));
    resumed.drainOutput(side.core);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: "stdout", data: new TextEncoder().encode("$ ") });
    ack(1);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ type: "stdout", data: new TextEncoder().encode("ready\r\n") });
  });

  it("ends the adopted processes when the guest agent announces itself again", async () => {
    const side = guest();
    const before = await booted(side);
    const resumed = side.agent();
    resumed.resume(side.core, { ...before.resumeState(new Uint8Array()), processes: [{ agentRequestId: 1, pid: 42, terminal: true, stdinOpen: true, command: "sh", tail: new Uint8Array() }] });
    const { host, events } = port();
    resumed.attach(1, host);

    side.send({ version: 7, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
    resumed.drainOutput(side.core);

    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "GUEST_CRASH" } }));
    expect(() => resumed.attach(1, port().host)).toThrow("not running");
  });
});
