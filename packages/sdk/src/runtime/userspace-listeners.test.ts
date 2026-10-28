import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import { decodeUserspaceListenerRead, decodeUserspaceListenerRecord } from "./userspace-listeners.js";

interface Entry { readonly port: number; readonly family: number; readonly address: readonly number[]; readonly flags: number; readonly program?: Uint8Array | string }

function l(port: number, family: number, address: readonly number[], flags: number, program?: string): Entry {
  return program === undefined ? { port, family, address, flags } : { port, family, address, flags, program };
}

function v6(last: number): number[] {
  return [...new Array<number>(15).fill(0), last];
}

/** A listener record v1 with the given header fields and entries. */
function record(generation: bigint, entries: readonly Entry[], header: { readonly version?: number; readonly count?: number } = {}): Uint8Array {
  const parts: number[] = [];
  const u16 = (value: number): void => { parts.push(value & 0xff, (value >> 8) & 0xff); };
  const u32 = (value: number): void => { u16(value & 0xffff); u16((value >>> 16) & 0xffff); };
  u32(header.version ?? 1);
  u32(header.count ?? entries.length);
  for (let shift = 0n; shift < 64n; shift += 8n) parts.push(Number((generation >> shift) & 0xffn));
  for (const entry of entries) {
    u16(entry.port);
    parts.push(entry.family, entry.flags);
    const address = [...entry.address, ...new Array<number>(16).fill(0)].slice(0, 16);
    parts.push(...address);
    const program = typeof entry.program === "string" ? new TextEncoder().encode(entry.program) : entry.program ?? new Uint8Array();
    u16(program.byteLength);
    parts.push(...program);
  }
  return Uint8Array.from(parts);
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const MALFORMED: Readonly<Record<string, Uint8Array>> = {
  "wrong version": record(1n, [], { version: 2 }),
  "count above 256": record(1n, [], { count: 257 }),
  "truncated record": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b01)]).slice(0, -1),
  "trailing bytes": Uint8Array.of(...record(1n, [l(3000, 4, [0, 0, 0, 0], 0b01)]), 0),
  "reserved flag bit": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b101)]),
  "family 5": record(1n, [l(3000, 5, [0, 0, 0, 0], 0b01)]),
  "IPv4 tail not zero": record(1n, [l(3000, 4, [0, 0, 0, 0, 1], 0b01)]),
  "invalid UTF-8 program": record(1n, [{ port: 3000, family: 4, address: [0, 0, 0, 0], flags: 0b11, program: Uint8Array.of(0xc3, 0x28) }]),
  "program longer than 256 bytes": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b11, "x".repeat(257))]),
  "program without the flag": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b01, "bun dev")]),
  "flag without a program": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b11)]),
  "port 0": record(1n, [l(0, 4, [0, 0, 0, 0], 0b01)]),
  "unsorted or duplicate records": record(1n, [l(3000, 4, [0, 0, 0, 0], 0b01), l(3000, 4, [0, 0, 0, 0], 0b01)]),
  "fewer bytes than a header": Uint8Array.of(1, 0, 0, 0),
};

describe("decodeUserspaceListenerRecord", () => {
  it("decodes record v1 into listening ports", () => {
    expect(decodeUserspaceListenerRecord(record(7n, [l(3000, 4, [0, 0, 0, 0], 0b11, "bun dev"), l(5000, 6, v6(1), 0b01)])))
      .toEqual({ generation: 7n, ports: [
        { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true },
        { port: 5000, address: "::1", program: null, previewable: true },
      ] });
  });

  it("keeps the full 64-bit generation", () => {
    expect(decodeUserspaceListenerRecord(record(0xffff_ffff_ffff_fffen, [])).generation).toBe(0xffff_ffff_ffff_fffen);
  });

  it("orders records by port, then family, then address", () => {
    const ports = decodeUserspaceListenerRecord(record(1n, [
      l(3000, 4, [127, 0, 0, 1], 0b01), l(3000, 4, [127, 0, 0, 2], 0b01), l(3000, 6, v6(1), 0b01), l(3001, 4, [10, 0, 0, 1], 0b00),
    ])).ports;
    expect(ports.map((port) => `${String(port.port)} ${port.address} ${String(port.previewable)}`))
      .toEqual(["3000 127.0.0.1 true", "3000 127.0.0.2 true", "3000 ::1 true", "3001 10.0.0.1 false"]);
  });

  it.each(Object.keys(MALFORMED))("rejects %s", (name) => {
    const bytes = MALFORMED[name];
    if (bytes === undefined) throw new Error(`no case ${name}`);
    expect(thrownBy(() => decodeUserspaceListenerRecord(bytes))).toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("never throws anything but a protocol error on random bytes", () => {
    let state = 0x9e37_79b9;
    const next = (): number => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state;
    };
    for (let round = 0; round < 10_000; round += 1) {
      const bytes = Uint8Array.from({ length: next() % 301 }, () => next() & 0xff);
      if (round % 3 === 0 && bytes.byteLength >= 8) bytes.set([1, 0, 0, 0, next() % 4, 0, 0, 0]);
      try {
        decodeUserspaceListenerRecord(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(VMError);
        expect(error).toMatchObject({ code: "PROTOCOL_ERROR" });
      }
    }
  });
});

describe("decodeUserspaceListenerRead", () => {
  it("decodes the three answers of a listener read", () => {
    expect(decodeUserspaceListenerRead({ kind: "none" })).toEqual({ generation: 0n, ports: [] });
    expect(decodeUserspaceListenerRead({ kind: "unchanged", generation: 4n })).toEqual({ generation: 4n, ports: null });
    expect(decodeUserspaceListenerRead({ kind: "listeners", record: record(5n, [l(3000, 4, [0, 0, 0, 0], 0b01)]) }))
      .toEqual({ generation: 5n, ports: [{ port: 3000, address: "0.0.0.0", program: null, previewable: true }] });
  });

  it.each([
    ["an unknown kind", { kind: "stale" }],
    ["an extra field", { kind: "none", generation: 0n }],
    ["a number generation", { kind: "unchanged", generation: 4 }],
    ["a negative generation", { kind: "unchanged", generation: -1n }],
    ["a generation above 64 bits", { kind: "unchanged", generation: 1n << 64n }],
    ["a record that is not bytes", { kind: "listeners", record: [1, 0, 0, 0] }],
    ["no record", null],
  ])("rejects a listener read with %s", (_name, value) => {
    expect(thrownBy(() => decodeUserspaceListenerRead(value))).toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});
