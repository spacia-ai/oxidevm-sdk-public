import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeInstallationRequest, encodeInstallationRequest, isInstallationSupervisoryOperation } from "./assistance-installation.js";

it("reserves a later sequence for release after retirement and materialization", () => {
  for (const kind of ["retire", "materialize", "capture", "capture-retire"]) {
    const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1,
      sequence: 0xffff_fffe, operation: { kind } };
    const bytes = encodeInstallationRequest(request, 6);
    expect(decodeInstallationRequest(bytes, 6)).toEqual(request);
    expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 6)).toThrow();
    expect(() => encodeInstallationRequest({ ...request, operation: { kind, path: "/untrusted" } }, 6)).toThrow();
    bytes.fill(255, 48, 52);
    expect(() => decodeInstallationRequest(bytes, 6)).toThrow();
  }
});

it("shares installation control and pipe bytes with the guest and rejects legacy admission", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-request-v6.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("missing fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const request = decodeInstallationRequest(bytes, 6);
    expect(encodeInstallationRequest(request, 6)).toEqual(bytes);
    for (const version of [3, 4, 5]) {
      expect(() => decodeInstallationRequest(bytes, version)).toThrow();
      expect(() => encodeInstallationRequest(request, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeInstallationRequest(bytes.slice(0, end), 6)).toThrow();
    expect(() => decodeInstallationRequest(Uint8Array.from([...bytes, 0]), 6)).toThrow();
    const unknown = bytes.slice(); unknown[52] = 255;
    expect(() => decodeInstallationRequest(unknown, 6)).toThrow();
    if (request.operation.kind === "start") {
      const invalidBoolean = bytes.slice(); invalidBoolean[53] = 2;
      expect(() => decodeInstallationRequest(invalidBoolean, 6)).toThrow();
      const invalidUtf8 = bytes.slice(); invalidUtf8[58] = 255;
      expect(() => decodeInstallationRequest(invalidUtf8, 6)).toThrow();
    }
    for (const patch of [{ process: 1 }, { installation: 0 }, { sequence: 0 }, { generation: 0 }]) {
      expect(() => encodeInstallationRequest({ ...request, ...patch }, 6)).toThrow();
    }
  }
});

it("requires canonical workspace paths and explicit frozen policy on the installation wire", () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1,
    operation: { kind: "start", cwd: "/", frozenLockfile: true } };
  expect(() => encodeInstallationRequest(request, 6)).not.toThrow();
  for (const cwd of ["", "relative", "/../outside", "/a/./b", "/a//b", "/a/", "/a\\b", "/a\0", "/\ud800", "/" + "é".repeat(2048)]) {
    expect(() => encodeInstallationRequest({ ...request, operation: { ...request.operation, cwd } }, 6)).toThrow();
  }
  for (const operation of [{ kind: "start", cwd: "/" }, { ...request.operation, frozenLockfile: 1 },
    { kind: "stop", cwd: "/" }, { ...request.operation, command: "sh" }]) {
    expect(() => encodeInstallationRequest({ ...request, operation }, 6)).toThrow();
  }
});

it("binds native bootstrap grants to one installation and rejects reused authority", async () => {
  const { encodeInstallationBootstrap, decodeInstallationBootstrap } = await import("./assistance-installation.js");
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1,
    operation: { kind: "start", cwd: "/", frozenLockfile: true } };
  const credits = ["installation-gateway", "network"].flatMap((producer, index) => ["data", "control"].map((pool, offset) => ({
    session: request.session, generation: 1, process: null, producer, pool, kind: "grant",
    sequence: index * 2 + offset + 1, reservation: index * 2 + offset + 1,
    bytes: pool === "data" ? 6 * 1024 * 1024 : 256 * 1024, entries: 128,
  })));
  const bootstrap = { request, credits, registry: "https://registry.npmjs.org" };
  const bytes = encodeInstallationBootstrap(bootstrap, 6);
  expect(decodeInstallationBootstrap(bytes, 6)).toEqual(bootstrap);
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-bootstrap-v6.hex", import.meta.url), "utf8");
  expect(Buffer.from(bytes).toString("hex")).toBe(fixture.trim().split(" ")[1]);
  for (const version of [3, 4, 5]) expect(() => decodeInstallationBootstrap(bytes, version)).toThrow();
  for (const patch of [{ generation: 2 }, { kind: "return" }, { producer: "guest" }, { reservation: 2 }, { sequence: 2 }, { process: 1 }, { bytes: 15 * 1024 * 1024 }, { entries: 4096 }]) {
    expect(() => encodeInstallationBootstrap({ ...bootstrap, credits: [{ ...credits[0], ...patch }, ...credits.slice(1)] }, 6)).toThrow();
  }
  for (const invalid of [{ ...bootstrap, credits: credits.slice(1) }, { ...bootstrap, extra: true },
    { ...bootstrap, request: { ...request, operation: { kind: "stop" } } }, { ...bootstrap, registry: "x".repeat(4097) }, { ...bootstrap, registry: "\ufeffhttps://registry.npmjs.org" }]) {
    expect(() => encodeInstallationBootstrap(invalid, 6)).toThrow();
  }
  for (const malformed of [bytes.slice(0, -1), new Uint8Array([...bytes, 0]), new Uint8Array(8193)]) {
    expect(() => decodeInstallationBootstrap(malformed, 6)).toThrow();
  }
});

it("distinguishes the native gateway ready header from registry frames", async () => {
  const { encodeInstallationGatewayReady, decodeInstallationGatewayReady } = await import("./assistance-installation.js");
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-ready-v6.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [value, hex] = line.split(" "); const port = Number(value);
    const bytes = encodeInstallationGatewayReady(port);
    expect(Buffer.from(bytes).toString("hex")).toBe(hex);
    expect(decodeInstallationGatewayReady(bytes)).toBe(port);
    for (const bad of [bytes.slice(1), new Uint8Array([...bytes, 0]), new Uint8Array(8)]) expect(() => decodeInstallationGatewayReady(bad)).toThrow();
  }
  for (const port of [0, -1, 65536, 1.5, NaN]) expect(() => encodeInstallationGatewayReady(port)).toThrow();
});

it("bounds installation pipe operations before encoding and owns decoded bytes", () => {
  const common = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 2 };
  for (const length of [1, 65536]) {
    for (const operation of [{ kind: "read", length }, { kind: "write", bytes: new Uint8Array(length).fill(255) }]) {
      const wire = encodeInstallationRequest({ ...common, operation }, 6);
      const decoded = decodeInstallationRequest(wire, 6);
      expect(decoded.operation).toEqual(operation);
      wire.fill(0);
      expect(decoded.operation).toEqual(operation);
    }
  }
  for (const operation of [
    ...[0, -1, 65537, 1.5, NaN].map(length => ({ kind: "read", length })),
    ...[new Uint8Array(0), new Uint8Array(65537), new Uint8Array(new SharedArrayBuffer(1)), [1]].map(bytes => ({ kind: "write", bytes })),
    { kind: "read", length: 1, process: 1 }, { kind: "write", bytes: new Uint8Array(1), extra: 1 },
  ]) expect(() => encodeInstallationRequest({ ...common, operation }, 6)).toThrow();
  for (const kind of ["read", "write"]) {
    const wire = encodeInstallationRequest({ ...common, operation: kind === "read" ? { kind, length: 1 } : { kind, bytes: new Uint8Array(1) } }, 6);
    for (const length of [0, 65537, 0xffff_ffff]) {
      new DataView(wire.buffer).setUint32(53, length, true);
      expect(() => decodeInstallationRequest(wire, 6)).toThrow();
    }
  }
});

it("bounds installation process controls and rejects injected launch arguments", () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 2 };
  for (const operation of [
    { kind: "execute", command: "sh" }, { kind: "execute", cwd: "/" },
    { kind: "stdin", child: 0, bytes: Uint8Array.of(1) },
    { kind: "stdin", child: 1, bytes: new Uint8Array() },
    { kind: "stdin", child: 1, bytes: new Uint8Array(65537) },
    { kind: "close-stdin", child: 0 },
    { kind: "signal", child: 1, signal: 3 },
    { kind: "output-ack", child: 1, stream: "stdin", sequence: 1, bytes: 1 },
    { kind: "output-ack", child: 1, stream: "stdout", sequence: 0, bytes: 1 },
    { kind: "output-ack", child: 1, stream: "stdout", sequence: 1, bytes: 0 },
  ]) expect(() => encodeInstallationRequest({ ...request, operation }, 6)).toThrow();
  const large = { ...request, operation: { kind: "stdin", child: 1, bytes: new Uint8Array(65536) } };
  expect(decodeInstallationRequest(encodeInstallationRequest(large, 6), 6)).toEqual(large);
});


it("bounds capture reads and preserves a release sequence", () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1,
    installation: 1, sequence: 1, operation: { kind: "capture-read", length: 65536 } };
  expect(decodeInstallationRequest(encodeInstallationRequest(request, 6), 6)).toEqual(request);
  for (const length of [0, 65537, -1, 1.5]) {
    expect(() => encodeInstallationRequest({ ...request, operation: { kind: "capture-read", length } }, 6)).toThrow();
  }
  expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 6)).toThrow();
});

it("binds workspace capture operations to closed sources and bounded reads", () => {
  const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 2 };
  for (const source of ["snapshot", "delta"]) {
    for (const operation of [{ kind: "workspace-capture", source },
      { kind: "workspace-capture-read", source, length: 65536 }, { kind: "workspace-capture-retire", source }]) {
      const request = { ...identity, operation };
      const bytes = encodeInstallationRequest(request, 6);
      const decoded = decodeInstallationRequest(bytes, 6);
      expect(decoded).toEqual(request);
      expect(isInstallationSupervisoryOperation(decoded.operation)).toBe(operation.kind === "workspace-capture-retire");
      bytes[53] = 3;
      expect(() => decodeInstallationRequest(bytes, 6)).toThrow();
      for (const change of [{ source: "dependencies" }, { path: "/outside" }]) {
        expect(() => encodeInstallationRequest({ ...request, operation: { ...operation, ...change } }, 6)).toThrow();
      }
      expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 6)).toThrow();
    }
    for (const length of [0, 65537]) expect(() => encodeInstallationRequest({ ...identity,
      operation: { kind: "workspace-capture-read", source, length } }, 6)).toThrow();
  }
});

it("shares a bounded v7 build policy frame and rejects old guests and extra authority", () => {
  const bytes = Uint8Array.from(Buffer.from(readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-build-policy-v7.hex", import.meta.url), "utf8").trim(), "hex"));
  const request = decodeInstallationRequest(bytes, 7);
  expect(request.operation).toEqual({ kind: "set-build-policy", bytes: new TextEncoder().encode("[]") });
  expect(encodeInstallationRequest(request, 7)).toEqual(bytes);
  for (const version of [3, 4, 5, 6]) {
    expect(() => decodeInstallationRequest(bytes, version)).toThrow();
    expect(() => encodeInstallationRequest(request, version)).toThrow();
  }
  for (const payload of [new Uint8Array(), new Uint8Array(65_537), new Uint8Array(new SharedArrayBuffer(2))]) {
    expect(() => encodeInstallationRequest({ ...request, operation: { kind: "set-build-policy", bytes: payload } }, 7)).toThrow();
  }
  expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 7)).toThrow();
  expect(() => encodeInstallationRequest({ ...request, operation: { ...request.operation, path: "/workspace/policy" } }, 7)).toThrow();
});

it("shares the v7 materialized-activation frame with exact 32-byte identities and rejects old guests", () => {
  const bytes = Uint8Array.from(Buffer.from(readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-activate-materialized-v7.hex", import.meta.url), "utf8").trim(), "hex"));
  const request = decodeInstallationRequest(bytes, 7);
  expect(request.operation).toEqual({ kind: "activate-materialized", generation: new Uint8Array(32).fill(1), inputs: new Uint8Array(32).fill(2) });
  expect(request.sequence).toBe(42);
  expect(encodeInstallationRequest(request, 7)).toEqual(bytes);
  for (const version of [3, 4, 5, 6]) {
    expect(() => decodeInstallationRequest(bytes, version)).toThrow();
    expect(() => encodeInstallationRequest(request, version)).toThrow();
  }
  for (const generation of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(new SharedArrayBuffer(32))]) {
    expect(() => encodeInstallationRequest({ ...request, operation: { kind: "activate-materialized", generation, inputs: new Uint8Array(32) } }, 7)).toThrow();
  }
  expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 7)).toThrow();
  const short = Uint8Array.from(bytes); short[53] = 31;
  expect(() => decodeInstallationRequest(short.subarray(0, short.length - 1), 7)).toThrow();
});

/** A prepare asks whether the activated generation already matches its
 * inputs and policy before starting an installer; guest seven only. */
it("shares the v7 current-generation check frame and rejects old guests", () => {
  const bytes = Uint8Array.from(Buffer.from(readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-check-current-v7.hex", import.meta.url), "utf8").trim(), "hex"));
  const request = decodeInstallationRequest(bytes, 7);
  expect(request.operation).toEqual({ kind: "check-current" });
  expect(request.sequence).toBe(42);
  expect(encodeInstallationRequest(request, 7)).toEqual(bytes);
  for (const version of [3, 4, 5, 6]) {
    expect(() => decodeInstallationRequest(bytes, version)).toThrow();
    expect(() => encodeInstallationRequest(request, version)).toThrow();
  }
  expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 7)).toThrow();
});
