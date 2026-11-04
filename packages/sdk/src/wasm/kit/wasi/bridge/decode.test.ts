// The oxidevm_bridge_v1 request records: exact decoding, and refusal of every broken bound before anything runs.
import { describe, expect, it } from "vitest";
import { decodeRequest } from "./command.js";
import { decodeDestination } from "./net.js";
import { WasiError } from "../context.js";

describe("command request decoding (OBL-NATIVE-VALIDATE)", () => {
  type Part = number | string | Uint8Array | { readonly u8: 0 | 1 };
  const N: Part = { u8: 0 }, Y: Part = { u8: 1 };
  const encode = (parts: readonly Part[]) => {
    const out: number[] = [];
    const u32 = (value: number) => { out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24); };
    for (const part of parts) {
      if (typeof part === "object" && "u8" in part) out.push(part.u8);
      else if (typeof part === "number") u32(part);
      else { const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part; u32(bytes.byteLength); out.push(...bytes); }
    }
    return Uint8Array.from(out);
  };
  const valid = ["/bin/x", 1, "a", N, N, new Uint8Array(), 1000, 10, 10] as const;
  const refused = (parts: readonly Part[]) => { try { decodeRequest(encode(parts)); return false; } catch (error) { return error instanceof WasiError; } };

  it("accepts a valid request exactly and refuses every broken bound before anything runs", () => {
    expect(decodeRequest(encode(valid))).toEqual({ command: "/bin/x", args: ["a"], input: new Uint8Array(), timeoutMs: 1000, stdoutLimit: 10, stderrLimit: 10 });
    expect(refused(["bin/x", 0, N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 64, ...Array.from({ length: 64 }, () => "a"), N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 1, "a\0b", N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 0, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 180_001, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 1000, 1024 * 1024 + 1, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, Y, 1, "=v", new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused([...valid, 0])).toBe(true);
    expect(refused(valid.slice(0, -1))).toBe(true);
  });
});

describe("destination decoding", () => {
  const record = (...parts: readonly (number | string)[]) => {
    const out: number[] = [];
    for (const part of parts) {
      if (typeof part === "number") out.push(part);
      else { const bytes = new TextEncoder().encode(part); out.push(bytes.byteLength & 0xff, (bytes.byteLength >> 8) & 0xff, 0, 0, ...bytes); }
    }
    return Uint8Array.from(out);
  };
  it("decodes TCP, TLS with ALPN and Unix destinations exactly and refuses malformed ones", () => {
    expect(decodeDestination(record(0, "db", 0x38, 0x15))).toEqual({ kind: "tcp", host: "db", port: 5432, tls: false, alpn: [] });
    expect(decodeDestination(record(1, "h", 0xbb, 0x01, 1, 0, 0, 0, "h2"))).toEqual({ kind: "tcp", host: "h", port: 443, tls: true, alpn: ["h2"] });
    expect(decodeDestination(record(2, "/run/x.sock"))).toEqual({ kind: "unix", path: "/run/x.sock" });
    for (const bad of [record(3, "x"), record(0, "h", 0, 0), record(0, "", 1, 0), record(2, "/x", 9), record(2, "a".repeat(108))]) expect(() => decodeDestination(bad)).toThrow(WasiError);
  });
});
