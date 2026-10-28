import { REGISTRY_PROTOCOL_VERSION } from "./registry.js";
import { expect, it } from "vitest";
import { decodeRegistryReply, decodeRegistryRequest } from "./registry.js";

const common = { version: REGISTRY_PROTOCOL_VERSION, session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1 };

it("admits metadata representation only in the new registry dialect", () => {
  const start = { ...common, version: 32, kind: "start", url: "https://registry.npmjs.org/react" };
  for (const representation of ["full", "install"]) {
    expect(decodeRegistryRequest({ ...start, representation })).toEqual({ ...start, representation });
    expect(() => decodeRegistryRequest({ ...start, version: 31, representation })).toThrow();
  }
  expect(decodeRegistryRequest({ ...start, version: 31 })).toEqual({ ...start, version: 31 });
  for (const representation of ["*/*", "application/json", null, 1]) {
    expect(() => decodeRegistryRequest({ ...start, representation })).toThrow();
  }
});

it("decodes bounded registry commands with exact nonzero identities", () => {
  expect(REGISTRY_PROTOCOL_VERSION).toBe(32);
  const start = { ...common, kind: "start", url: "https://registry.npmjs.org/react" };
  expect(decodeRegistryRequest(start)).toEqual(start);
  for (const extra of [{ version: 30 }, { version: 33 }, { sequence: 0 }, { sequence: 0x1_0000_0000 }, { installation: -1 }, { url: "x".repeat(4097) }, { process: 1 }]) {
    expect(() => decodeRegistryRequest({ ...start, ...extra })).toThrow();
  }
});

it("rejects ambiguous headers and invalid registry body allocations", () => {
  const head = { ...common, correlation: 1, kind: "headers", request: 1, reservation: 2, status: 200 };
  for (const headers of [
    [["content-type", "text/plain"], ["content-type", "application/json"]],
    [["content-length", "-1"]], [["content-length", "9007199254740992"]],
    [["content-type", "text/plain\x01"]], [["set-cookie", "secret=value"]],
  ]) expect(() => decodeRegistryReply({ ...head, headers })).toThrow();
  const data = { ...common, correlation: 1, kind: "data", request: 1, reservation: 2, done: false };
  for (const bytes of [new Uint8Array(new SharedArrayBuffer(1)), new Uint8Array(new ArrayBuffer(65536), 0, 1), new Uint8Array(65537), new Uint8Array(0)]) {
    expect(() => decodeRegistryReply({ ...data, bytes })).toThrow();
  }
  expect(decodeRegistryReply({ ...data, bytes: new Uint8Array([1]) })).toMatchObject({ kind: "data" });
});


it("requires exact reservations for registry control replies and their acknowledgements", () => {
  const reply = { ...common, correlation: 1, kind: "started", request: 1, reservation: 7 };
  expect(decodeRegistryReply(reply)).toEqual(reply);
  const ack = { ...common, kind: "acknowledge-control", correlation: 1, reservation: 7 };
  expect(decodeRegistryRequest(ack)).toEqual(ack);
  for (const patch of [{ reservation: 0 }, { correlation: 0 }, { request: 1 }]) {
    expect(() => decodeRegistryRequest({ ...ack, ...patch })).toThrow();
  }
  expect(() => decodeRegistryReply({ ...common, correlation: 1, kind: "started", request: 1 })).toThrow();
});

it("bounds registry failure details before transport encoding", () => {
  const reply = { ...common, correlation: 1, kind: "failure", reservation: 7 };
  const error = { code: "RELAY_ERROR", message: "upstream failed", detail: { phase: "headers" } };
  expect(decodeRegistryReply({ ...reply, error })).toMatchObject({ error });
  for (const error of [
    { code: "RELAY_ERROR", message: "x".repeat(513) },
    { code: "RELAY_ERROR", message: "failed", detail: { payload: new Uint8Array(65536) } },
    { code: "RELAY_ERROR", message: "failed", detail: { phase: "unknown" } },
    { code: "RELAY_ERROR", message: "failed", detail: { cleanupFailed: "yes" } },
  ]) expect(() => decodeRegistryReply({ ...reply, error })).toThrow();
});

it("rejects retirement receipts that reuse an issued credit sequence", () => {
  const credit = { session: common.session, generation: common.generation, kind: "return", producer: "network",
    process: null, pool: "control", bytes: 4096, entries: 4, sequence: 1, reservation: 1 };
  expect(() => decodeRegistryReply({ ...common, kind: "retired", correlation: 1,
    credits: [credit, { ...credit, pool: "data", reservation: 2 }],
  })).toThrow();
});

it("decodes an optional network profile on retirement and rejects malformed profiles", () => {
  const credit = { session: common.session, generation: common.generation, kind: "return", producer: "network",
    process: null, pool: "control", bytes: 4096, entries: 4, sequence: 1, reservation: 1 };
  const retired = { ...common, kind: "retired", correlation: 1, credits: [credit, { ...credit, pool: "data", sequence: 2, reservation: 2 }] };
  expect(decodeRegistryReply(retired)).not.toHaveProperty("profile");
  const profile = { requests: 3, bytes: 4096, creditWaitMs: 1.5, upstreamMs: 20 };
  expect(decodeRegistryReply({ ...retired, profile })).toMatchObject({ kind: "retired", profile });
  for (const invalid of [{ ...profile, extra: 1 }, { ...profile, requests: -1 }, { ...profile, upstreamMs: Number.NaN }, { ...profile, bytes: "4096" }]) {
    expect(() => decodeRegistryReply({ ...retired, profile: invalid })).toThrow();
  }
});
