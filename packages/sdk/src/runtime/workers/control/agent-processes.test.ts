import { afterEach, describe, expect, it, vi } from "vitest";

import { type AgentFrame, AgentKind } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { AgentProcesses } from "./agent-processes.js";
import { recordingCore } from "./core.test-support.js";

const channels: MessageChannel[] = [];

function processes(): AgentProcesses {
  const { core } = recordingCore();
  return new AgentProcesses({
    core: () => core,
    diskBridge: () => undefined,
    consoleTail: () => "",
    session: () => ({ active: true, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" }),
  });
}

function port(): { readonly host: MessagePort; readonly events: unknown[]; readonly ack: (sequence: number) => void } {
  const channel = new MessageChannel();
  channels.push(channel);
  const events: unknown[] = [];
  channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => events.push(event.data));
  channel.port2.start();
  return {
    host: channel.port1,
    events,
    ack: (sequence) => channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId: 5, type: "output-ack", sequence }),
  };
}

function event(kind: number, pid: number, body: Uint8Array): AgentFrame {
  const payload = new Uint8Array(4 + body.byteLength);
  new DataView(payload.buffer).setUint32(0, pid, true);
  payload.set(body, 4);
  return { version: 7, kind, requestId: 5, status: 0, payload };
}

function exit(pid: number, code: number): AgentFrame {
  const frame = event(AgentKind.exit, pid, new Uint8Array(4));
  new DataView(frame.payload.buffer).setInt32(4, code, true);
  return frame;
}

describe("guest agent processes", () => {
  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("relays output and exit in order, one event per acknowledgement", async () => {
    const agent = processes();
    const { host, events, ack } = port();
    agent.started(agent.open(5, host, false, "cat"), 42);

    agent.receive(event(AgentKind.stdout, 42, new TextEncoder().encode("hi")));
    agent.receive(exit(42, 0));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ sessionId: 5, sequence: 1, type: "stdout", data: new TextEncoder().encode("hi") });
    ack(1);

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ sequence: 2, type: "exit", termination: { kind: "exit", code: 0 } });
    expect(agent.size).toBe(0);
  });

  it("fails a process whose unacknowledged output passes its 1 MiB buffer", async () => {
    const agent = processes();
    const { host, events } = port();
    agent.started(agent.open(5, host, false, "cat"), 42);

    // The first event goes out at once; the rest queue until the 17th passes 1 MiB.
    let sent = 0;
    while (agent.size !== 0 && sent < 64) {
      agent.receive(event(AgentKind.stdout, 42, new Uint8Array(64 * 1024)));
      sent += 1;
    }

    expect(sent).toBe(17);
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "QUOTA_EXCEEDED" } }));
    expect(agent.size).toBe(0);
  });

  it("refuses output for a process it did not spawn or from another pid", () => {
    const agent = processes();
    expect(() => agent.receive(event(AgentKind.stdout, 42, new Uint8Array(1)))).toThrow("unknown process");
    const { host } = port();
    agent.started(agent.open(5, host, false, "cat"), 42);
    expect(() => agent.receive(event(AgentKind.stdout, 43, new Uint8Array(1)))).toThrow("wrong process id");
  });

  it("records each live process with its newest output for a snapshot", async () => {
    const agent = processes();
    const { host, events, ack } = port();
    agent.started(agent.open(5, host, true, "bun dev"), 42);
    agent.receive(event(AgentKind.stdout, 42, new TextEncoder().encode("ab")));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    ack(1);
    agent.receive(event(AgentKind.stderr, 42, new TextEncoder().encode("c")));
    agent.closedStdin(42);

    expect(agent.adoptable()).toEqual([
      { agentRequestId: 5, pid: 42, terminal: true, stdinOpen: false, command: "bun dev", tail: new TextEncoder().encode("abc") },
    ]);
  });

  it("adopts a restored process and replays its screen, then what it printed since, when a page attaches", async () => {
    const agent = processes();
    agent.adopt([{ agentRequestId: 5, pid: 42, terminal: true, stdinOpen: true, command: "bun dev", tail: new TextEncoder().encode("before ") }]);
    agent.receive(event(AgentKind.stdout, 42, new TextEncoder().encode("after")));
    // A process restored and saved again keeps the command it was started with.
    expect(agent.adoptable()).toMatchObject([{ agentRequestId: 5, command: "bun dev" }]);
    const { host, events, ack } = port();

    expect(agent.attach(5, host)).toEqual({ pid: 42, sessionId: 5, terminal: true });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: "stdout", sequence: 1, data: new TextEncoder().encode("before ") });
    ack(1);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ type: "stdout", sequence: 2, data: new TextEncoder().encode("after") });
    expect(() => agent.attach(5, port().host)).toThrow("already attached");
  });

  it("keeps the newest megabyte of a restored process no page has attached to", () => {
    const agent = processes();
    agent.adopt([{ agentRequestId: 5, pid: 42, terminal: false, stdinOpen: true, command: "cat", tail: new Uint8Array() }]);

    for (let index = 0; index < 32; index += 1) agent.receive(event(AgentKind.stdout, 42, new Uint8Array(64 * 1024).fill(index)));

    expect(agent.size).toBe(1);
  });

  it("ends every session when the guest agent restarts", async () => {
    const agent = processes();
    agent.adopt([
      { agentRequestId: 5, pid: 42, terminal: true, stdinOpen: true, command: "sh", tail: new Uint8Array() },
      { agentRequestId: 6, pid: 43, terminal: false, stdinOpen: true, command: "sh", tail: new Uint8Array() },
    ]);
    const { host, events } = port();
    agent.attach(5, host);

    agent.endAll(new VMError("GUEST_CRASH", "the guest agent restarted"));

    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "GUEST_CRASH" } }));
    expect(agent.size).toBe(0);
  });
});
