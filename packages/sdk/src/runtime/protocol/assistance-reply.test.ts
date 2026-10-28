import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { assistanceReplyCapacity, decodeAssistanceReply, encodeAssistanceReply, matchAssistanceReply } from "./assistance-reply.js";
import type { AssistanceRequest } from "./assistance.js";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 2, sequence: 3 };

describe("assistance reply boundary", () => {
  it("requires either no generation or the two exact dependency digests", () => {
    const request: AssistanceRequest = { ...identity, operation: { kind: "check-dependencies", policy: Uint8Array.of(91, 93) } };
    for (const length of [0, 1, 32, 63, 64, 65]) {
      const reply = { ...identity, result: { kind: "data", bytes: new Uint8Array(length) } } as const;
      if (length === 0 || length === 64) expect(matchAssistanceReply(request, reply)).toEqual(reply.result);
      else expect(() => matchAssistanceReply(request, reply)).toThrow();
    }
  });
  it("bounds maximum data and all error strings within operation reply credits", () => {
    const read = { kind: "read", fd: 1, length: 65536, offset: null } as const;
    const error = encodeAssistanceReply({ ...identity, result: {
      kind: "error", errno: 1, code: "E".repeat(4095), syscall: "a".repeat(4095),
      path: "x".repeat(4095), destination: "y".repeat(4095),
    } }, 5);
    expect(error.byteLength).toBeLessThanOrEqual(assistanceReplyCapacity({ kind: "close", fd: 1 }));
    expect(encodeAssistanceReply({ ...identity, result: { kind: "data", bytes: new Uint8Array(65536) } }, 5).byteLength)
      .toBeLessThanOrEqual(assistanceReplyCapacity(read));
    expect(assistanceReplyCapacity(read)).toBeLessThan(128 * 1024);
  });
  it("shares explicit v5 stat metadata without reinterpreting legacy replies", () => {
    const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-stat-v5.hex", import.meta.url), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const [name, hex] = line.split(" ");
      if (hex === undefined) throw new Error("invalid fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const reply = decodeAssistanceReply(bytes, 5);
      expect(reply.result).toMatchObject({ kind: "stat", stat: { details: {
        rdev: name === "birth" ? 259n : 0n, birthtimeNs: name === "birth" ? -123456789n : null,
      } } });
      expect(encodeAssistanceReply(reply, 5)).toEqual(bytes);
      expect(() => decodeAssistanceReply(bytes, 4)).toThrow();
      for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceReply(bytes.slice(0, end), 5)).toThrow();
      const legacy = encodeAssistanceReply(reply, 4);
      expect(decodeAssistanceReply(legacy, 4).result).toMatchObject({ kind: "stat", stat: { details: null } });
      expect(() => decodeAssistanceReply(legacy, 5)).toThrow();
      expect(() => encodeAssistanceReply(decodeAssistanceReply(legacy), 5)).toThrow("requires Linux stat metadata");
      const malformed = bytes.slice(); malformed[legacy.length + 8] = 2;
      expect(() => decodeAssistanceReply(malformed, 5)).toThrow("birth time availability");
      expect(() => decodeAssistanceReply(Uint8Array.from([...bytes, 0]), 5)).toThrow();
    }
  });
  it("agrees with every Rust golden reply", () => {
    const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-reply-v4.hex", import.meta.url), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const [kind, hex] = line.split(" ");
      if (hex === undefined) throw new Error("invalid fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const reply = decodeAssistanceReply(bytes);
      expect(reply.result.kind).toBe(kind);
      expect(encodeAssistanceReply(reply)).toEqual(bytes);
    }
  });
  it("retains partial completion and owned bytes", () => {
    const bytes = new Uint8Array(65536).fill(17);
    const encoded = encodeAssistanceReply({ ...identity, result: { kind: "data", bytes } });
    const reply = decodeAssistanceReply(encoded);
    encoded.fill(0);
    expect(reply).toEqual({ ...identity, result: { kind: "data", bytes } });
    const partial = { ...identity, result: { kind: "written", count: 7 } };
    expect(decodeAssistanceReply(encodeAssistanceReply(partial))).toEqual(partial);
  });

  it("preserves Linux errors separately from protocol errors", () => {
    const error = { ...identity, result: { kind: "error", errno: 13, code: "EACCES", syscall: "open", path: "/private", destination: null } };
    expect(decodeAssistanceReply(encodeAssistanceReply(error))).toEqual(error);
    expect(() => encodeAssistanceReply({ ...error, extra: true })).toThrow();
    expect(() => encodeAssistanceReply({ ...error, result: { ...error.result, errno: 0 } })).toThrow();
  });

  it("rejects truncation, trailing bytes, oversized chunks and wrong reply identities or kinds", () => {
    const encoded = encodeAssistanceReply({ ...identity, result: { kind: "opened", fd: 1 } });
    for (let end = 0; end < encoded.length; end += 1) expect(() => decodeAssistanceReply(encoded.subarray(0, end))).toThrow();
    expect(() => decodeAssistanceReply(Uint8Array.from([...encoded, 0]))).toThrow();
    expect(() => encodeAssistanceReply({ ...identity, result: { kind: "data", bytes: new Uint8Array(65537) } })).toThrow();
    const request: AssistanceRequest = { ...identity, operation: { kind: "read", fd: 1, length: 10, offset: null } };
    expect(() => matchAssistanceReply(request, decodeAssistanceReply(encoded))).toThrow();
    expect(() => matchAssistanceReply(request, { ...identity, generation: 2, result: { kind: "data", bytes: new Uint8Array() } })).toThrow();
    expect(() => matchAssistanceReply(request, { ...identity, result: { kind: "data", bytes: new Uint8Array(11) } })).toThrow();
  });
});

it("retains a v5 terminal outcome across a racing stop until explicit acknowledgement", () => {
  const hex = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-terminal-v5.hex", import.meta.url), "utf8").trim().split(" ")[1];
  if (hex === undefined) throw new Error("Missing terminal fixture");
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const reply = decodeAssistanceReply(bytes, 5);
  expect(reply).toEqual({ ...identity, result: { kind: "terminal", sequence: 0xffff_ffff, errno: 32 } });
  expect(encodeAssistanceReply(reply, 5)).toEqual(bytes);
  expect(() => decodeAssistanceReply(bytes, 4)).toThrow();
  expect(() => encodeAssistanceReply(reply, 4)).toThrow();
  expect(matchAssistanceReply({ ...identity, operation: { kind: "stop" } }, reply)).toEqual(reply.result);
  expect(() => matchAssistanceReply({ ...identity, operation: { kind: "terminal-ack", sequence: 1 } }, reply)).toThrow();
  for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceReply(bytes.slice(0, end), 5)).toThrow();
  expect(() => decodeAssistanceReply(Uint8Array.from([...bytes, 0]), 5)).toThrow();
});

it("v6 retains the exact v5 stat and terminal payloads", () => {
  for (const fixture of ["task-stat-v5.hex", "task-terminal-v5.hex"]) {
    const text = readFileSync(new URL(`../../../../../tests/fixtures/assistance/${fixture}`, import.meta.url), "utf8");
    for (const line of text.trim().split("\n")) {
      const hex = line.split(" ")[1];
      if (hex === undefined) throw new Error("missing fixture bytes");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(decodeAssistanceReply(bytes, 6)).toEqual(decodeAssistanceReply(bytes, 5));
      expect(encodeAssistanceReply(decodeAssistanceReply(bytes, 6), 6)).toEqual(bytes);
    }
  }
});

it("retains an empty Linux error path and rejects nonabsolute cwd replies", () => {
  const reply = { ...identity, result: { kind: "error", errno: 2, code: "ENOENT", syscall: "chdir", path: "", destination: null } } as const;
  expect(decodeAssistanceReply(encodeAssistanceReply(reply, 7), 7)).toEqual(reply);
  const request: AssistanceRequest = { ...identity, operation: { kind: "getcwd" } };
  expect(() => matchAssistanceReply(request, { ...identity, result: { kind: "path", path: "relative" } })).toThrow();
});

it("completes a fork with the native spawn reply shape only", async () => {
  const { matchAssistanceReply, assistanceReplyCapacity } = await import("./assistance-reply.js");
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: 2,
    operation: { kind: "fork" as const, process: 2, dependencies: null } };
  const reply = { session: request.session, generation: 1, process: 1, sequence: 2 };
  expect(matchAssistanceReply(request, { ...reply, result: { kind: "spawned", child: 1, pid: 9 } })).toEqual({ kind: "spawned", child: 1, pid: 9 });
  expect(() => matchAssistanceReply(request, { ...reply, result: { kind: "unit" } })).toThrow();
  expect(assistanceReplyCapacity(request.operation)).toBe(20 * 1024);
});
