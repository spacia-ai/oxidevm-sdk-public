import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeInstallationReply, encodeInstallationReply, installationReplyMatches } from "./assistance-installation-reply.js";
import type { InstallationRequest } from "./assistance-installation.js";

const common = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1 };
it("shares exact installation replies with Rust and rejects malformed or legacy bytes", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-reply-v6.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("missing fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const reply = decodeInstallationReply(bytes, 6);
    expect(encodeInstallationReply(reply, 6)).toEqual(bytes);
    for (const version of [3, 4, 5]) {
      expect(() => decodeInstallationReply(bytes, version)).toThrow();
      expect(() => encodeInstallationReply(reply, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeInstallationReply(bytes.slice(0, end), 6)).toThrow();
    expect(() => decodeInstallationReply(new Uint8Array([...bytes, 0]), 6)).toThrow();
    const bad = bytes.slice(); bad[52] = 255;
    expect(() => decodeInstallationReply(bad, 6)).toThrow();
  }
});
it("rejects stale correlation, wrong result shapes, and excess read/write acknowledgement", () => {
  const request: InstallationRequest = { ...common, operation: { kind: "read", length: 1 } };
  const reply = { ...common, result: { kind: "data", bytes: new Uint8Array([7]) } };
  expect(installationReplyMatches(request, decodeInstallationReply(encodeInstallationReply(reply, 6), 6))).toBe(true);
  for (const patch of [{ sequence: 2 }, { installation: 2 }, { generation: 2 }, { session: "22222222-2222-4333-8444-555555555555" },
    { result: { kind: "written", count: 1 } }, { result: { kind: "data", bytes: new Uint8Array(2) } }]) {
    expect(installationReplyMatches(request, decodeInstallationReply(encodeInstallationReply({ ...reply, ...patch }, 6), 6))).toBe(false);
  }
  const cases: readonly [InstallationRequest["operation"], unknown, boolean][] = [
    [{ kind: "start", cwd: "/", frozenLockfile: true }, { kind: "ready", port: 3210 }, true],
    [{ kind: "stop" }, { kind: "stopped" }, true],
    [{ kind: "retire" }, { kind: "retired" }, true],
    [{ kind: "materialize" }, { kind: "materialized" }, true],
    [{ kind: "materialize" }, { kind: "retired" }, false],
    [{ kind: "retire" }, { kind: "materialized" }, false],
    [{ kind: "stop" }, { kind: "retired" }, false],
    [{ kind: "retire" }, { kind: "stopped" }, false],
    [{ kind: "execute" }, { kind: "spawned", child: 1, pid: 42 }, true],
    [{ kind: "execute" }, { kind: "ready", port: 42 }, false],
    [{ kind: "execute" }, { kind: "unit" }, false],
    [{ kind: "close-stdin", child: 1 }, { kind: "unit" }, true],
    [{ kind: "signal", child: 1, signal: 15 }, { kind: "acknowledged" }, false],
    [{ kind: "signal", child: 1, signal: 15 }, { kind: "unit" }, true],
    [{ kind: "output-ack", child: 1, stream: "stdout", sequence: 1, bytes: 1 }, { kind: "unit" }, true],
    [{ kind: "stdin", child: 1, bytes: Uint8Array.of(1) }, { kind: "written", count: 2 }, false],
    [{ kind: "stdin", child: 1, bytes: Uint8Array.of(1) }, { kind: "written", count: 1 }, true],
    [{ kind: "acknowledge" }, { kind: "acknowledged" }, true],
    [{ kind: "stop" }, { kind: "acknowledged" }, false],
    [{ kind: "acknowledge" }, { kind: "written", count: 1 }, false],
    [{ kind: "read", length: 1 }, { kind: "data", bytes: new Uint8Array() }, true],
    [{ kind: "write", bytes: new Uint8Array(1) }, { kind: "written", count: 1 }, true],
    [{ kind: "write", bytes: new Uint8Array(1) }, { kind: "written", count: 2 }, false],
    [{ kind: "stop" }, { kind: "error", errno: 125 }, true],
  ];
  for (const [operation, result, accepted] of cases) expect(installationReplyMatches({ ...common, operation },
    decodeInstallationReply(encodeInstallationReply({ ...common, result }, 6), 6))).toBe(accepted);
});
it("bounds reply data and fields and owns decoded data", () => {
  const result = { kind: "data", bytes: new Uint8Array(65536).fill(7) };
  const wire = encodeInstallationReply({ ...common, result }, 6);
  const decoded = decodeInstallationReply(wire, 6);
  wire.fill(0);
  expect(decoded.result).toEqual(result);
  for (const invalid of [{ kind: "spawned", child: 0, pid: 42 }, { kind: "spawned", child: 1, pid: 0 },
    { kind: "spawned", child: 1, pid: 0x8000_0000 }, { kind: "unit", pid: 42 }, { kind: "ready", port: 0 }, { kind: "ready", port: 65536 }, { kind: "written", count: 65537 },
    { kind: "error", errno: 0 }, { kind: "error", errno: 4096 }, { kind: "stopped", extra: true },
    { kind: "data", bytes: new Uint8Array(65537) }, { kind: "data", bytes: new Uint8Array(new SharedArrayBuffer(1)) }]) {
    expect(() => encodeInstallationReply({ ...common, result: invalid }, 6)).toThrow();
  }
  expect(() => encodeInstallationReply({ ...common, result, process: 1 }, 6)).toThrow();
});


it("bounds capture metadata and requires a distinct retirement receipt", () => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1 };
  for (const result of [{ kind: "capture-ready", bytes: 2 ** 40 + 1 }, { kind: "capture-ready", bytes: -1 },
    { kind: "capture-retired", errno: 4096 }, { kind: "capture-retired", errno: -1 }]) {
    expect(() => encodeInstallationReply({ ...binding, result }, 6)).toThrow();
  }
  const request = { ...binding, operation: { kind: "capture-retire" as const } };
  expect(installationReplyMatches(request, { ...binding, result: { kind: "data", bytes: new Uint8Array() } })).toBe(false);
  expect(installationReplyMatches(request, { ...binding, result: { kind: "capture-retired", errno: 28 } })).toBe(true);
});
