import { decodeAssistancePreparation } from "./assistance-control.js";
import { describe, expect, it } from "vitest";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.ts";

describe("assistance control requests", () => {
  it("selects approval storage by a bounded workspace identity without accepting dependency authority", () => {
    const pair = new MessageChannel();
    const request = { version: PROTOCOL_VERSION, id: 1, type: "assistance-spawn", entry: "main.cjs", cwd: "/", args: [], env: {}, port: pair.port1,
      workspaceBaseSha256: "a".repeat(64) };
    try {
      expect(decodeControlIncoming(request)).toEqual(request);
      for (const workspaceBaseSha256 of ["", "A".repeat(64), 7]) expect(() => decodeControlIncoming({ ...request, workspaceBaseSha256 })).toThrow();
      expect(() => decodeControlIncoming({ ...request, dependencies: { generation: "a".repeat(64), inputsSha256: "b".repeat(64) } })).toThrow();
    } finally { pair.port1.close(); pair.port2.close(); }
  });
  it("accepts only a private network port and no caller-supplied network authority", () => {
    const pair = new MessageChannel();
    const request = { version: PROTOCOL_VERSION, id: 1, type: "assistance-network-attach", port: pair.port1 };
    try {
      expect(decodeControlIncoming(request)).toEqual(request);
      expect(() => decodeControlIncoming({ ...request, port: {} })).toThrow();
      expect(() => decodeControlIncoming({ ...request, generation: 1 })).toThrow();
      const failure = { version: PROTOCOL_VERSION, id: 2, type: "assistance-network-failed" };
      expect(decodeControlIncoming(failure)).toEqual(failure);
      expect(() => decodeControlIncoming({ ...failure, reason: "untrusted" })).toThrow();
    } finally { pair.port1.close(); pair.port2.close(); }
  });
  it("binds preparation credits to the exact bootstrap owner", () => {
    const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
    const credit = { ...binding, kind: "grant", producer: "bootstrap", process: null, pool: "data", bytes: 1024, entries: 1, sequence: 1, reservation: 1 };
    const credits = [credit, { ...credit, sequence: 2, reservation: 2 }];
    expect(decodeAssistancePreparation({ ...binding, credits })).toEqual({ ...binding, credits });
    for (const patch of [{ generation: 2 }, { kind: "return" }, { producer: "guest", process: 1 }, { pool: "control" }, { reservation: 1 }, { sequence: 1 }]) {
      expect(() => decodeAssistancePreparation({ ...binding, credits: [credit, { ...credits[1], ...patch }] })).toThrow();
    }
  });
  it("bounds input separately from EOF and rejects shared or oversized bytes", () => {
    const input = { version: PROTOCOL_VERSION, id: 1, type: "assistance-input", process: 1, bytes: Uint8Array.of(65) };
    expect(decodeControlIncoming(input)).toEqual(input);
    expect(decodeControlIncoming({ ...input, bytes: null })).toEqual({ ...input, bytes: null });
    expect(() => decodeControlIncoming({ ...input, bytes: new Uint8Array(65537) })).toThrow();
    expect(() => decodeControlIncoming({ ...input, bytes: new Uint8Array(new SharedArrayBuffer(1)) })).toThrow();
  });
  it("decodes read-only binding status without accepting enablement or binding authority", () => {
    const request = { version: PROTOCOL_VERSION, id: 2, type: "assistance-status" };
    expect(decodeControlIncoming(request)).toEqual(request);
    expect(() => decodeControlIncoming({ ...request, generation: 2 })).toThrow();
  });
  it("decodes the dedicated lifecycle path and rejects extra authority", () => {
    const input = { version: PROTOCOL_VERSION, id: 1, type: "assistance-prepare" };
    expect(decodeControlIncoming(input)).toEqual(input);
    expect(() => decodeControlIncoming({ ...input, enabled: true })).toThrow();
    expect(() => decodeControlIncoming({ ...input, type: "assistance-stop", process: 0, signal: "KILL" })).toThrow();
  });
  it("rejects flags, traversal and oversized startup before reserving a task", () => {
    const channel = new MessageChannel();
    const input = { version: PROTOCOL_VERSION, id: 1, type: "assistance-spawn", entry: "entry.cjs", cwd: "/", args: [], env: {}, port: channel.port1 };
    try {
      expect(() => decodeControlIncoming({ ...input, entry: "-e" })).toThrow();
      expect(() => decodeControlIncoming({ ...input, cwd: "/../" })).toThrow();
      expect(() => decodeControlIncoming({ ...input, args: ["x".repeat(131072)] })).toThrow();
    } finally { channel.port1.close(); channel.port2.close(); }
  });
});


it("admits preparation only with a bounded workspace path, explicit lock policy and private port", () => {
  const pair = new MessageChannel();
  const input = { version: PROTOCOL_VERSION, id: 1, type: "assistance-install", cwd: "/app", frozenLockfile: true,
    workspaceBaseSha256: "a".repeat(64), port: pair.port1 };
  try {
    expect(decodeControlIncoming(input)).toEqual(input);
    for (const patch of [{ cwd: "/../" }, { frozenLockfile: "false" }, { workspaceBaseSha256: "invalid" },
      { port: {} }, { registry: "https://untrusted.example" }, { generation: "a".repeat(64) }]) {
      expect(() => decodeControlIncoming({ ...input, ...patch })).toThrow();
    }
  } finally { pair.port1.close(); pair.port2.close(); }
});

it("validates content-scoped approval persistence without installation authority", () => {
  const decision = { name: "sharp", version: "0.34.3", integrity: `sha512-${btoa("a".repeat(64))}`, decision: "allow" };
  const request = { version: PROTOCOL_VERSION, id: 7, type: "assistance-build-policy", workspaceBaseSha256: "a".repeat(64), decisions: [decision] };
  expect(decodeControlIncoming(request)).toEqual(request);
  for (const patch of [{ workspaceBaseSha256: "bad" }, { decisions: [{ ...decision, integrity: "bad" }] },
    { decisions: [{ ...decision, decision: "yes" }] }, { installation: 1 }]) {
    expect(() => decodeControlIncoming({ ...request, ...patch })).toThrow();
  }
});

describe("installation profile control operation", () => {
  it("decodes the request exactly and its optional profile response", async () => {
    const { assistanceResponseDecoders } = await import("./assistance-control.js");
    const request = { version: PROTOCOL_VERSION, id: 4, type: "assistance-installation-profile" };
    expect(decodeControlIncoming(request)).toEqual(request);
    expect(() => decodeControlIncoming({ ...request, installation: 1 })).toThrow();
    const decode = assistanceResponseDecoders["assistance-installation-profile"];
    expect(decode(undefined)).toBeUndefined();
    const profile = { installation: 2, phases: [{ name: "connect", startedMs: 1, endedMs: 2.5 }], exchanges: [],
      registry: { requests: [], dropped: 0, network: null }, gateway: null };
    expect(decode(profile)).toEqual(profile);
    expect(() => decode({ ...profile, phases: [{ name: "connect", startedMs: 1 }] })).toThrow();
    expect(() => decode(null)).toThrow();
  });
});
