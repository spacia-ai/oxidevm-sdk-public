import { describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { MAX_AGENT_STATE_BYTES } from "../snapshot-manifest.js";
import { MAX_RESUME_OUTBOUND_BYTES } from "./agent-input.js";
import {
  type AgentResumeState,
  decodeAgentResumeState,
  encodeAgentResumeState,
  MAX_AGENT_RESUME_STATE_BYTES,
  MAX_RESUME_COMMAND_BYTES,
  MAX_RESUME_TAIL_BYTES,
} from "./agent-resume-state.js";

function state(overrides: Partial<AgentResumeState> = {}): AgentResumeState {
  return {
    dialect: 7,
    capabilities: 3 | 32,
    nextRequestId: 41,
    inbound: new Uint8Array([0x4f, 0x58, 0x47]),
    inboundSkip: 2,
    inboundLost: false,
    outbound: new Uint8Array([1, 2, 3, 4]),
    outboundSequence: 12,
    processes: [
      { agentRequestId: 9, pid: 120, terminal: true, stdinOpen: true, command: "bun dev", tail: new TextEncoder().encode("$ bun dev\r\n") },
      { agentRequestId: 17, pid: 133, terminal: false, stdinOpen: false, command: "sh -c true", tail: new Uint8Array() },
    ],
    consoleTail: new TextEncoder().encode("login: "),
    ...overrides,
  };
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("agent resume state (OXHA v1)", () => {
  it("round-trips the host side of an agent session", () => {
    const encoded = encodeAgentResumeState(state());

    expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe("OXHA");
    expect(decodeAgentResumeState(encoded)).toEqual(state());
  });

  it("round-trips a session with capabilities 127, listener watching included", () => {
    const session = state({ capabilities: 127 });
    expect(decodeAgentResumeState(encodeAgentResumeState(session))).toEqual(session);
  });

  it("names the command each relayed process runs, within 4 KiB", () => {
    const named = state({
      processes: [{ agentRequestId: 9, pid: 120, terminal: true, stdinOpen: true, command: "bun dev · ünïcode", tail: new Uint8Array() }],
    });
    expect(decodeAgentResumeState(encodeAgentResumeState(named))).toEqual(named);

    // A longer command keeps its start, cut at a character, so the record stays readable.
    const long = state({
      processes: [{ agentRequestId: 9, pid: 120, terminal: true, stdinOpen: true, command: `${"x".repeat(4095)}ü and more`, tail: new Uint8Array() }],
    });
    expect(decodeAgentResumeState(encodeAgentResumeState(long)).processes[0]?.command).toBe("x".repeat(4095));
  });

  it("encodes records its decoder reads at every limit, within what a restore point stores", () => {
    const largest = state({
      inbound: new Uint8Array(1024 * 1024).fill(1),
      inboundSkip: 0,
      // Every unsent fragment of a transfer as large as the agent input queue holds.
      outbound: new Uint8Array(MAX_RESUME_OUTBOUND_BYTES).fill(2),
      nextRequestId: 1_000,
      processes: Array.from({ length: 256 }, (_, index) => ({
        agentRequestId: index + 1,
        pid: index + 100,
        terminal: true,
        stdinOpen: true,
        command: "c".repeat(MAX_RESUME_COMMAND_BYTES),
        tail: new Uint8Array(MAX_RESUME_TAIL_BYTES).fill(3),
      })),
      consoleTail: new Uint8Array(MAX_RESUME_TAIL_BYTES).fill(4),
    });

    const encoded = encodeAgentResumeState(largest);

    expect(encoded.byteLength).toBe(MAX_AGENT_RESUME_STATE_BYTES);
    expect(MAX_AGENT_RESUME_STATE_BYTES).toBeLessThanOrEqual(MAX_AGENT_STATE_BYTES);
    const decoded = decodeAgentResumeState(encoded);
    expect(decoded.outbound.byteLength).toBe(MAX_RESUME_OUTBOUND_BYTES);
    expect(decoded.processes).toHaveLength(256);
  });

  it("keeps the first 256 processes of a longer list, so the record stays readable", () => {
    const many = state({
      nextRequestId: 1_000,
      processes: Array.from({ length: 300 }, (_, index) => ({
        agentRequestId: index + 1, pid: index + 100, terminal: false, stdinOpen: false, command: "sleep 1", tail: new Uint8Array(),
      })),
    });

    const decoded = decodeAgentResumeState(encodeAgentResumeState(many));

    expect(decoded.processes.map((process) => process.agentRequestId)).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
  });

  it("records a session whose agent never announced itself", () => {
    const idle = state({
      dialect: null,
      capabilities: 0,
      nextRequestId: 1,
      inbound: new Uint8Array(),
      inboundSkip: 0,
      inboundLost: false,
      outbound: new Uint8Array(),
      outboundSequence: 0,
      processes: [],
    });

    expect(decodeAgentResumeState(encodeAgentResumeState(idle))).toEqual(idle);
  });

  it("keeps only the newest bytes of a tail that outgrew its bound", () => {
    const long = new Uint8Array(MAX_RESUME_TAIL_BYTES + 10).map((_, index) => index % 251);

    const decoded = decodeAgentResumeState(encodeAgentResumeState(state({ consoleTail: long })));

    expect(decoded.consoleTail).toEqual(long.subarray(10));
  });

  it("rejects records that are damaged, from another version or inconsistent", () => {
    const encoded = encodeAgentResumeState(state());
    const variants: Uint8Array[] = [
      encoded.subarray(0, encoded.byteLength - 1),
      Uint8Array.from([...encoded, 0]),
      Uint8Array.from(encoded, (byte, index) => (index === 0 ? 0x41 : byte)),
      Uint8Array.from(encoded, (byte, index) => (index === 4 ? 2 : byte)),
      Uint8Array.from(encoded, (byte, index) => (index === 6 ? 8 : byte)),
      Uint8Array.from(encoded, (byte, index) => (index === 7 ? 2 : byte)),
    ];
    for (const bytes of variants) {
      expect(failure(() => decodeAgentResumeState(bytes))).toBeInstanceOf(VMError);
    }
    for (const inconsistent of [
      state({ processes: [{ agentRequestId: 41, pid: 1, terminal: false, stdinOpen: false, command: "sh", tail: new Uint8Array() }] }),
      state({ processes: [{ agentRequestId: 9, pid: 0, terminal: false, stdinOpen: false, command: "sh", tail: new Uint8Array() }] }),
      state({ dialect: null }),
      state({ inboundLost: true }),
    ]) {
      expect(failure(() => decodeAgentResumeState(encodeAgentResumeState(inconsistent)))).toBeInstanceOf(VMError);
    }
  });
});
