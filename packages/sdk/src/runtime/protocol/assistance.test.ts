import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeAssistanceIdentity, decodeAssistanceRequest, encodeAssistanceRequest } from "./assistance.js";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 2, sequence: 3 };

describe("private assistance requests", () => {
  it("shares bounded guest-7 dependency admission bytes with Rust", () => {
    const line = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-request-v7.hex", import.meta.url), "utf8").trim();
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const request = { ...identity, operation: { kind: "check-dependencies", policy: Uint8Array.of(91, 93) } };
    expect(encodeAssistanceRequest(request)).toEqual(bytes);
    expect(decodeAssistanceRequest(bytes)).toEqual(request);
    for (const policy of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(255), new Uint8Array(65537).fill(32)]) {
      expect(() => encodeAssistanceRequest({ ...identity, operation: { kind: "check-dependencies", policy } })).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
  });
  it("carries application environment through authenticated task startup", () => {
    const request = { ...identity, operation: { kind: "start", cwd: "/workspace", env: { TEST_VALUE: "value", EMPTY: "" } } };
    expect(decodeAssistanceRequest(encodeAssistanceRequest(request))).toEqual(request);
  });
  it("round-trips every shared Rust/TypeScript golden operation byte for byte", () => {
    const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-request-v4.hex", import.meta.url), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const [kind, hex] = line.split(" ");
      if (hex === undefined) throw new Error("invalid golden fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const decoded = decodeAssistanceRequest(bytes);
      expect(decoded.operation.kind).toBe(kind);
      expect(encodeAssistanceRequest(decoded)).toEqual(bytes);
      for (let end = 0; end < bytes.length; end += 1) {
        expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
      }
    }
  });
  it("rejects unknown identity fields", () => {
    expect(() => decodeAssistanceIdentity({ ...identity, uid: 0 })).toThrow();
  });
  it("retains task identity and exact file offsets across binary transport", () => {
    const request = { ...identity, operation: { kind: "read", fd: 7, length: 65536, offset: 0x1fffffffffffffn } } as const;
    expect(decodeAssistanceRequest(encodeAssistanceRequest(request))).toEqual(request);
  });

  it("rejects excessive chunks, unknown fields and invalid identity before encoding", () => {
    expect(() => encodeAssistanceRequest({ ...identity, operation: { kind: "read", fd: 7, length: 65537, offset: null } })).toThrow();
    expect(() => encodeAssistanceRequest({ ...identity, root: "/", operation: { kind: "close", fd: 7 } })).toThrow();
    expect(() => encodeAssistanceRequest({ ...identity, process: 0, operation: { kind: "close", fd: 7 } })).toThrow();
  });

  it("rejects truncated, trailing and unknown operation bytes", () => {
    const bytes = encodeAssistanceRequest({ ...identity, operation: { kind: "close", fd: 7 } });
    expect(() => decodeAssistanceRequest(bytes.slice(0, -1))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeAssistanceRequest(trailing)).toThrow();
    const unknown = bytes.slice();
    unknown[52] = 255;
    expect(() => decodeAssistanceRequest(unknown)).toThrow();
  });
});

it("shares exact guest-7 cwd operations with Rust", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-cwd-v7.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [kind, hex] = line.split(" ");
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const request = { ...identity, operation: kind === "getcwd" ? { kind } : { kind, path: ".." } };
    expect(encodeAssistanceRequest(request)).toEqual(bytes);
    expect(decodeAssistanceRequest(bytes)).toEqual(request);
    expect(() => encodeAssistanceRequest({ ...request, operation: { ...request.operation, extra: true } })).toThrow();
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
  }
});

it("shares bounded guest-7 access operation bytes with Rust", () => {
  const hex = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-access-v7.hex", import.meta.url), "utf8").trim().split(" ")[1];
  if (hex === undefined) throw new Error("invalid fixture");
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const request = { ...identity, operation: { kind: "access", path: "./value", mode: 7 } };
  expect(encodeAssistanceRequest(request)).toEqual(bytes);
  expect(decodeAssistanceRequest(bytes)).toEqual(request);
  for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
  for (const mode of [-1, 8, 1.5, "4"]) expect(() => encodeAssistanceRequest({ ...identity, operation: { ...request.operation, mode } })).toThrow();
});

it("shares bounded guest-7 fork operation bytes with Rust and rejects malformed dependency identity", () => {
  const lines = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-fork-v7.hex", import.meta.url), "utf8").trim().split("\n");
  const fixture = (name: string): Uint8Array => {
    const hex = lines.find(line => line.startsWith(name))?.split(" ")[1];
    if (hex === undefined) throw new Error("invalid fixture");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  };
  const forking = { ...identity, process: 1, sequence: 2 };
  const dependencies = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
  const inherit = { ...forking, operation: { kind: "fork", process: 2, dependencies } };
  const fresh = { ...forking, operation: { kind: "fork", process: 2, dependencies: null } };
  expect(encodeAssistanceRequest(inherit)).toEqual(fixture("fork-inherit"));
  expect(decodeAssistanceRequest(fixture("fork-inherit"))).toEqual(inherit);
  expect(encodeAssistanceRequest(fresh)).toEqual(fixture("fork-fresh"));
  expect(decodeAssistanceRequest(fixture("fork-fresh"))).toEqual(fresh);
  for (const bytes of [fixture("fork-inherit"), fixture("fork-fresh")]) {
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
  }
  for (const operation of [
    { kind: "fork", process: 0, dependencies: null }, { kind: "fork", process: 1, dependencies: null },
    { kind: "fork", process: 2, dependencies: new Uint8Array(63) }, { kind: "fork", process: 2, dependencies: new Uint8Array(65) },
    { kind: "fork", process: 2 }, { kind: "fork", process: 2, dependencies: null, extra: 1 },
  ]) expect(() => encodeAssistanceRequest({ ...forking, operation })).toThrow();
  const flagged = fixture("fork-fresh");
  flagged[flagged.length - 1] = 2;
  expect(() => decodeAssistanceRequest(flagged)).toThrow();
});
