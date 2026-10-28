import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { VMError } from "../errors.ts";
import {
  AGENT_LISTENERS_MAX_BYTES,
  decodeAgentListeners,
  encodeWatchListeners,
  listenerAddressText,
  previewableAddress,
} from "./agent-listeners.ts";

const VECTORS = readFileSync(new URL("../../../../../tests/fixtures/agent/listeners.hex", import.meta.url), "utf8");

function vector(name: string): Uint8Array {
  const line = VECTORS.split("\n").find((entry) => entry.startsWith(`${name} `));
  if (line === undefined) throw new Error(`vector ${name} is missing`);
  const hex = line.slice(name.length + 1);
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

interface Entry {
  readonly family: number;
  readonly address: readonly number[];
  readonly port: number;
  readonly inode?: bigint;
  readonly pid: number;
  readonly program?: Uint8Array | string;
}

/** A LISTENERS payload with the given entries and header fields. */
function payload(entries: readonly Entry[], header: { readonly count?: number } = {}): Uint8Array {
  const parts: number[] = [];
  const u32 = (value: number): void => { parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff); };
  u32(header.count ?? entries.length);
  u32(0);
  u32(0);
  for (const entry of entries) {
    parts.push(entry.family, ...[...entry.address, ...new Array<number>(16).fill(0)].slice(0, 16));
    u32(entry.port);
    const inode = entry.inode ?? 1n;
    for (let shift = 0n; shift < 64n; shift += 8n) parts.push(Number((inode >> shift) & 0xffn));
    u32(entry.pid);
    const program = typeof entry.program === "string" ? new TextEncoder().encode(entry.program) : entry.program ?? new Uint8Array();
    u32(program.byteLength);
    parts.push(...program);
  }
  return Uint8Array.from(parts);
}

const ANY4: Entry = { family: 4, address: [0, 0, 0, 0], port: 3000, pid: 31, program: "bun dev" };

function codeOf(bytes: Uint8Array): string {
  try {
    decodeAgentListeners(bytes);
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "decoded";
}

describe("guest agent listener lists", () => {
  it("decodes the shared vectors exactly", () => {
    expect(decodeAgentListeners(vector("empty"))).toEqual({ listeners: [], omitted: 0, malformed: 0 });
    expect(decodeAgentListeners(vector("typical"))).toEqual({
      omitted: 1,
      malformed: 2,
      listeners: [
        { family: 4, address: "0.0.0.0", port: 3000, inode: 201n, pid: 31, program: "bun dev" },
        { family: 4, address: "127.0.0.1", port: 4000, inode: 202n, pid: 0, program: null },
        { family: 6, address: "::1", port: 4001, inode: 203n, pid: 44, program: "bun -e x" },
        { family: 6, address: "::ffff:127.0.0.1", port: 4002, inode: 204n, pid: 45, program: "node server.js" },
        { family: 6, address: "::", port: 5173, inode: 205n, pid: 46, program: "node vite" },
      ],
    });
  });

  it("encodes the watch requests as the shared vectors", () => {
    expect(encodeWatchListeners("subscribe")).toEqual(vector("subscribe"));
    expect(encodeWatchListeners("unsubscribe")).toEqual(vector("unsubscribe"));
  });

  it.each([
    ["more than 256 listeners", payload([], { count: 257 })],
    ["family 5", payload([{ ...ANY4, family: 5 }])],
    ["IPv4 padding that is not zero", payload([{ ...ANY4, address: [0, 0, 0, 0, 1] }])],
    ["port 0", payload([{ ...ANY4, port: 0 }])],
    ["port 65536", payload([{ ...ANY4, port: 65_536 }])],
    ["a program over 256 bytes", payload([{ ...ANY4, program: "x".repeat(257) }])],
    ["a program without an owning pid", payload([{ ...ANY4, pid: 0 }])],
    ["a program that is not UTF-8", payload([{ ...ANY4, program: Uint8Array.of(0xff, 0xfe) }])],
    ["a control character in a program", payload([{ ...ANY4, program: "bun\u0007dev" }])],
    ["unsorted entries", payload([{ ...ANY4, port: 4000 }, { ...ANY4, port: 3000 }])],
    ["duplicate entries", payload([ANY4, ANY4])],
    ["a truncated entry", payload([ANY4]).subarray(0, 20)],
    ["trailing bytes", Uint8Array.of(...payload([ANY4]), 0)],
    ["a payload over 75,020 bytes", new Uint8Array(AGENT_LISTENERS_MAX_BYTES + 1)],
  ])("rejects %s", (_name, bytes) => {
    expect(codeOf(bytes)).toBe("PROTOCOL_ERROR");
  });

  it("formats addresses canonically", () => {
    expect(listenerAddressText(4, Uint8Array.of(192, 0, 2, 2))).toBe("192.0.2.2");
    expect(listenerAddressText(6, Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1))).toBe("2001:db8::1");
  });

  it.each([
    ["0.0.0.0", true],
    ["127.0.0.1", true],
    ["192.0.2.2", true],
    ["::", true],
    ["::ffff:0.0.0.0", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:192.0.2.2", true],
    ["::1", false],
    ["127.0.0.2", false],
    ["10.0.0.5", false],
  ])("%s is previewable: %s", (address, previewable) => {
    expect(previewableAddress(address)).toBe(previewable);
  });
});
