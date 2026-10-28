import { describe, expect, it } from "vitest";
import { decodeBrokerEvent, decodeBrokerCommand, decodeBrokerFailure, decodeBrokerHeartbeat } from "./assistance-broker.ts";

import { encodeAssistanceReply } from "./assistance-reply.ts";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 2, sequence: 3 };
it("keeps VM supervision independent of process identity and validates its own sequence", () => {
  const binding = { session: identity.session, generation: identity.generation };
  const heartbeat = { kind: "ping", binding, sequence: 0xffff_ffff };
  expect(decodeBrokerHeartbeat(heartbeat)).toEqual(heartbeat);
  for (const sequence of [0, -1, 0x100000000]) expect(() => decodeBrokerHeartbeat({ ...heartbeat, sequence })).toThrow();
  expect(() => decodeBrokerHeartbeat({ ...heartbeat, binding: { ...binding, process: 1 } })).toThrow();
  const error = { code: "GUEST_CRASH", message: "broker lost" };
  expect(decodeBrokerFailure({ kind: "broker-failed", binding, error })).toEqual({ binding, error });
  expect(() => decodeBrokerFailure({ kind: "broker-failed", binding: { ...binding, generation: 0 }, error })).toThrow();
});
describe("assistance broker boundary", () => {
  it("copies bounded output and retains the complete process identity", () => {
    const bytes = Uint8Array.of(3, 4);
    const value = { kind: "output", identity, stream: "stdout", bytes };
    const event = decodeBrokerEvent(value);
    expect(event).toEqual(value);
    bytes.fill(9);
    if (event.kind !== "output") throw new Error("output");
    expect(event.bytes).toEqual(Uint8Array.of(3, 4));
  });
  it("rejects invalid identity, excessive output, and extra authority fields", () => {
    expect(() => decodeBrokerEvent({ kind: "exit", identity: { ...identity, sequence: 0 }, code: 0 })).toThrow();
    expect(() => decodeBrokerEvent({ kind: "exit", identity, code: 0, uid: 0 })).toThrow();
    expect(() => decodeBrokerEvent({ kind: "output", identity, stream: "stdout", bytes: new Uint8Array(65537) })).toThrow();
    expect(() => decodeBrokerEvent({ kind: "request", identity, operation: { kind: "start", cwd: "/" } })).toThrow();
    expect(() => decodeBrokerEvent({ kind: "request", identity, operation: { kind: "check-dependencies", policy: Uint8Array.of(91, 93) } })).toThrow();
  });
});

describe("assistance broker command boundary", () => {
  it("retains startup values and rejects an invalid command before worker creation", async () => {
    const { decodeBrokerCommand } = await import("./assistance-broker.ts");
    const command = { kind: "start", identity, entry: "/workspace/main.cjs", cwd: "/workspace", args: ["a"], env: { TEST: "yes" } };
    expect(decodeBrokerCommand(command)).toEqual(command);
    expect(() => decodeBrokerCommand({ ...command, buffer: new ArrayBuffer(2) })).toThrow();
    expect(() => decodeBrokerCommand({ ...command, args: [null] })).toThrow();
  });
});

it("rejects a broker reply whose encoded identity differs from its envelope", () => {
  const bytes = encodeAssistanceReply({ ...identity, result: { kind: "unit" } });
  expect(decodeBrokerCommand({ kind: "reply", identity, bytes })).toEqual({ kind: "reply", identity, bytes });
  expect(() => decodeBrokerCommand({ kind: "reply", identity: { ...identity, generation: 2 }, bytes })).toThrow();
});


it("validates explicit and idle exit events with the same bounded status and identity", () => {
  for (const kind of ["exit", "exit-request"]) {
    expect(decodeBrokerEvent({ kind, identity, code: 255 })).toEqual({ kind, identity, code: 255 });
    for (const code of [-1, 256, 1.5, "0", null]) expect(() => decodeBrokerEvent({ kind, identity, code })).toThrow();
    expect(() => decodeBrokerEvent({ kind, identity, code: 0, force: true })).toThrow();
  }
});

describe("fork broker wires", () => {
  const request = { entry: "/workspace/child.js", args: [], execArgv: [], cwd: "/workspace", env: {}, silent: true };
  it("carries fork events with the parent's identity and bounded child references", () => {
    expect(decodeBrokerEvent({ kind: "fork", identity, request })).toEqual({ kind: "fork", identity, request });
    expect(() => decodeBrokerEvent({ kind: "fork", identity, request: { ...request, entry: "child.js" } })).toThrow();
    for (const signal of ["TERM", "KILL", "INT", "HUP"]) {
      expect(decodeBrokerEvent({ kind: "fork-signal", identity, child: 3, signal })).toEqual({ kind: "fork-signal", identity, child: 3, signal });
    }
    expect(() => decodeBrokerEvent({ kind: "fork-signal", identity, child: 3, signal: "USR1" })).toThrow();
    expect(() => decodeBrokerEvent({ kind: "fork-signal", identity, child: 0, signal: "TERM" })).toThrow();
    const bytes = Uint8Array.of(1, 2);
    const input = decodeBrokerEvent({ kind: "fork-input", identity, child: 3, bytes });
    bytes.fill(7);
    expect(input).toEqual({ kind: "fork-input", identity, child: 3, bytes: Uint8Array.of(1, 2) });
    expect(decodeBrokerEvent({ kind: "fork-input", identity, child: 3, bytes: null })).toEqual({ kind: "fork-input", identity, child: 3, bytes: null });
    expect(() => decodeBrokerEvent({ kind: "fork-input", identity, child: 3, bytes: new Uint8Array(65537) })).toThrow();
    expect(decodeBrokerEvent({ kind: "fork-output-ack", identity, child: 3, chunk: 9 })).toEqual({ kind: "fork-output-ack", identity, child: 3, chunk: 9 });
    expect(() => decodeBrokerEvent({ kind: "fork-output-ack", identity, child: 3, chunk: 0 })).toThrow();
    for (const signal of [1, 2, 9, 15]) expect(decodeBrokerEvent({ kind: "exit-signal", identity, signal })).toEqual({ kind: "exit-signal", identity, signal });
    expect(() => decodeBrokerEvent({ kind: "exit-signal", identity, signal: 3 })).toThrow();
  });
  it("routes fork commands: replies, private channels, silent output, exits and catchable signals", () => {
    const start = { kind: "start", identity, entry: "/workspace/child.js", cwd: "/workspace", args: [], env: {}, parent: 1, silent: true, execArgv: ["--enable-source-maps"] };
    expect(decodeBrokerCommand(start)).toEqual(start);
    expect(() => decodeBrokerCommand({ ...start, parent: 0 })).toThrow();
    expect(() => decodeBrokerCommand({ ...start, parent: identity.process })).toThrow();
    expect(() => decodeBrokerCommand({ ...start, silent: 1 })).toThrow();
    expect(() => decodeBrokerCommand({ ...start, execArgv: ["--inspect"] })).toThrow();
    const orphan: Record<string, unknown> = { ...start };
    delete orphan["parent"];
    expect(() => decodeBrokerCommand(orphan)).toThrow();
    for (const reply of [{ kind: "spawned", process: 3, pid: 40 }, { kind: "error", errno: 11, code: "EAGAIN" }]) {
      expect(decodeBrokerCommand({ kind: "fork-reply", identity, reply })).toEqual({ kind: "fork-reply", identity, reply });
    }
    expect(() => decodeBrokerCommand({ kind: "fork-reply", identity, reply: { kind: "spawned", process: 3 } })).toThrow();
    const { port1 } = new MessageChannel();
    try {
      expect(decodeBrokerCommand({ kind: "fork-channel", identity, child: 3, port: port1 })).toEqual({ kind: "fork-channel", identity, child: 3, port: port1 });
      expect(() => decodeBrokerCommand({ kind: "fork-channel", identity, child: 3, port: {} })).toThrow();
    } finally { port1.close(); }
    const bytes = Uint8Array.of(5);
    expect(decodeBrokerCommand({ kind: "fork-output", identity, child: 3, stream: "stderr", bytes, chunk: 1 })).toEqual({ kind: "fork-output", identity, child: 3, stream: "stderr", bytes, chunk: 1 });
    expect(() => decodeBrokerCommand({ kind: "fork-output", identity, child: 3, stream: "stdin", bytes, chunk: 1 })).toThrow();
    expect(() => decodeBrokerCommand({ kind: "fork-output", identity, child: 3, stream: "stdout", bytes: new Uint8Array(65537), chunk: 1 })).toThrow();
    for (const termination of [{ kind: "exit", code: 77 }, { kind: "signal", signal: 15 }, { kind: "error", error: { code: "GUEST_CRASH", message: "lost" } }]) {
      expect(decodeBrokerCommand({ kind: "fork-exit", identity, child: 3, termination })).toEqual({ kind: "fork-exit", identity, child: 3, termination });
    }
    expect(() => decodeBrokerCommand({ kind: "fork-exit", identity, child: 3, termination: { kind: "exit", code: 256 } })).toThrow();
    for (const signal of ["TERM", "INT", "HUP"]) expect(decodeBrokerCommand({ kind: "signal", identity, signal })).toEqual({ kind: "signal", identity, signal });
    expect(() => decodeBrokerCommand({ kind: "signal", identity, signal: "KILL" })).toThrow();
  });
});
