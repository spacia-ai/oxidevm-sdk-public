import { REGISTRY_PROTOCOL_VERSION } from "./registry.js";
import { expect, it } from "vitest";
import { decodeRegistryWire, encodeRegistryWire } from "./registry-wire.js";

const common = { version: REGISTRY_PROTOCOL_VERSION, session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 2, sequence: 3 } as const;
it("round trips registry control and binary data without JSON byte arrays", () => {
  const start = { ...common, kind: "start" as const, url: "https://registry.npmjs.org/@scope%2fpackage" };
  expect(decodeRegistryWire(encodeRegistryWire(start, "request"), "request")).toEqual(start);
  const data = { ...common, kind: "data" as const, correlation: 2, request: 1, reservation: 7, done: false, bytes: new Uint8Array(65_536).fill(255) };
  const wire = encodeRegistryWire(data, "reply");
  expect(wire.byteLength).toBeLessThan(data.bytes.byteLength + 1024);
  expect(decodeRegistryWire(wire, "reply")).toEqual(data);
});
it("rejects truncation, trailing bytes, wrong direction and oversized frames", () => {
  const wire = encodeRegistryWire({ ...common, kind: "retire" }, "request");
  for (const size of [0, 3, wire.byteLength - 1]) expect(() => decodeRegistryWire(wire.slice(0, size), "request")).toThrow();
  const extra = new Uint8Array(wire.byteLength + 1); extra.set(wire);
  expect(() => decodeRegistryWire(extra, "request")).toThrow();
  expect(() => decodeRegistryWire(wire, "reply")).toThrow();
  expect(() => decodeRegistryWire(new Uint8Array(131_073), "request")).toThrow();
});
it("rejects forged JSON body fields and noncanonical metadata before reconstructing data", () => {
  function frame(json: string, bytes = new Uint8Array()) {
    const metadata = new TextEncoder().encode(json);
    const wire = new Uint8Array(4 + metadata.byteLength + bytes.byteLength);
    new DataView(wire.buffer).setUint32(0, metadata.byteLength, true);
    wire.set(metadata, 4); wire.set(bytes, 4 + metadata.byteLength); return wire;
  }
  const header = { ...common, kind: "data", correlation: 2, request: 1, reservation: 7, done: true };
  expect(() => decodeRegistryWire(frame(JSON.stringify({ ...header, bytes: [] })), "reply")).toThrow();
  expect(() => decodeRegistryWire(frame(JSON.stringify(header).replace('"sequence":3', '"sequence":1,"sequence":3')), "reply")).toThrow();
  expect(() => decodeRegistryWire(frame(JSON.stringify({ ...header, done: false })), "reply")).toThrow();
});
it("retains header and acknowledgement identities across byte encoding", () => {
  for (const request of [
    { ...common, kind: "read", request: 1 },
    { ...common, kind: "cancel", request: 1 },
    { ...common, kind: "acknowledge", request: 1, reservation: 9 },
    { ...common, kind: "acknowledge-control", correlation: 2, reservation: 9 },
  ]) expect(decodeRegistryWire(encodeRegistryWire(request, "request"), "request")).toEqual(request);
  for (const reply of [
    { ...common, correlation: 2, kind: "headers", request: 1, reservation: 9, status: 404, headers: [["content-type", "application/json"]] },
    { ...common, correlation: 2, kind: "started", request: 1, reservation: 9 },
    { ...common, correlation: 2, kind: "cancelled", request: 1, reservation: 9 },
    { ...common, correlation: 2, kind: "data", request: 1, reservation: 9, bytes: new Uint8Array(), done: true },
  ]) expect(decodeRegistryWire(encodeRegistryWire(reply, "reply"), "reply")).toEqual(reply);
});
it("rejects malformed UTF-8 and BOM-prefixed metadata", () => {
  for (const bytes of [[0xff], [0xef, 0xbb, 0xbf, 0x7b, 0x7d]]) {
    const wire = new Uint8Array(4 + bytes.length);
    new DataView(wire.buffer).setUint32(0, bytes.length, true); wire.set(bytes, 4);
    expect(() => decodeRegistryWire(wire, "request")).toThrow();
  }
});
