import { describe, expect, it } from "vitest";
import { decodeTrust, MAX_TRUST_ANCHORS, MAX_TRUST_BYTES, trustChunks } from "./tls-trust.js";

describe("decodeTrust (a TLS session's extra anchors)", () => {
  it("takes none, or copies of PEM and DER entries", () => {
    expect(decodeTrust(undefined)).toEqual([]);
    const pem = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\n"), der = Uint8Array.of(0x30, 0x82);
    const decoded = decodeTrust([pem, der]);
    expect(decoded).toEqual([pem, der]);
    pem[0] = 0;
    expect(decoded[0]?.[0]).toBe(0x2d);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it.each([
    ["a string", "cert.pem"],
    ["an ArrayBuffer entry", [new ArrayBuffer(4)]],
    ["an empty entry", [new Uint8Array()]],
    ["a number entry", [1]],
    ["too many entries", Array.from({ length: MAX_TRUST_ANCHORS + 1 }, () => Uint8Array.of(1))],
    ["too many bytes", [new Uint8Array(MAX_TRUST_BYTES), Uint8Array.of(1)]],
  ])("refuses %s with ERR_TLS_INVALID_TRUST", (_name, value) => {
    let refusal: unknown;
    try { decodeTrust(value); } catch (error: unknown) { refusal = error; }
    expect(refusal).toMatchObject({ name: "NetError", code: "ERR_TLS_INVALID_TRUST" });
  });

  it("takes a full root bundle: 512 entries and 2 MiB, as the engine's certificate and byte caps", () => {
    expect(MAX_TRUST_ANCHORS).toBe(512);
    expect(MAX_TRUST_BYTES).toBe(2 * 1024 * 1024);
    expect(decodeTrust(Array.from({ length: MAX_TRUST_ANCHORS }, () => Uint8Array.of(1)))).toHaveLength(MAX_TRUST_ANCHORS);
  });
});

describe("trustChunks (an entry split to fit the TLS exchange buffer)", () => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const block = (index: number): string => `# CA ${String(index)}\n-----BEGIN CERTIFICATE-----\n${"A".repeat(60)}\n-----END CERTIFICATE-----\n`;

  it("keeps an entry that fits", () => {
    const entry = encoder.encode(block(0));
    expect(trustChunks(entry, entry.length)).toEqual([entry]);
  });

  it("splits a PEM bundle after certificate blocks only, each chunk within capacity, dropping a text-only tail", () => {
    const blocks = Array.from({ length: 10 }, (_, index) => block(index)), capacity = block(0).length * 3 + 5;
    const chunks = trustChunks(encoder.encode(`${blocks.join("")}# end of bundle\n`), capacity);
    expect(chunks.map(chunk => decoder.decode(chunk))).toEqual([blocks.slice(0, 3), blocks.slice(3, 6), blocks.slice(6, 9), blocks.slice(9)].map(part => part.join("")));
    expect(chunks.every(chunk => chunk.length <= capacity)).toBe(true);
  });

  it.each([
    ["a DER certificate", Uint8Array.from({ length: 100 }, () => 0x30), 50],
    ["a PEM block", encoder.encode(block(0)), 50],
    ["an unterminated block", encoder.encode(`${block(0)}-----BEGIN CERTIFICATE-----\n${"A".repeat(200)}`), block(0).length + 1],
  ])("refuses %s larger than the capacity with ERR_TLS_INVALID_TRUST", (_name, entry, capacity) => {
    let refusal: unknown;
    try { trustChunks(entry, capacity); } catch (error: unknown) { refusal = error; }
    expect(refusal).toMatchObject({ name: "NetError", code: "ERR_TLS_INVALID_TRUST" });
  });
});
