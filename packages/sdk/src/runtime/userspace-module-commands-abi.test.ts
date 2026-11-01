import { describe, expect, it } from "vitest";
import { Reader, Writer } from "./js-process/codec.js";
import {
  decodeModuleCommandApplication, encodeModuleCommandTable, MODULE_COMMAND_MAX_CONCURRENCY, MODULE_COMMAND_MAX_NAMES, type ModuleCommandEntry,
} from "./userspace-module-commands-abi.js";

const text = (value: string) => new TextEncoder().encode(value);

/** The engine's OXMC v1 reader (`runtime/module_commands/table.rs::decode`), mirrored to check what the encoder writes. */
function readTable(bytes: Uint8Array): ModuleCommandEntry[] {
  const r = new Reader(bytes);
  expect(new TextDecoder().decode(r.raw(4))).toBe("OXMC");
  expect(r.u32()).toBe(1);
  const entries = Array.from({ length: r.u32() }, () => ({ registration: r.u32(), concurrency: r.u32(), name: new TextDecoder("utf-8", { fatal: true }).decode(r.raw(r.u32())) }));
  r.end();
  return entries;
}

/** The engine's OXMA v1 writer (`runtime/module_commands/apply.rs::TableApplication::encode`). */
function oxma({ magic = "OXMA", version = 1, outcome = 0, changed = 0, entry = 0xffff_ffff, errno = 0, skipped = [] as readonly (readonly [number, number])[] } = {}): Uint8Array {
  const writer = new Writer().raw(text(magic)).u32(version).u8(outcome).u8(changed).u32(entry).u32(errno).u32(skipped.length);
  for (const [index, reason] of skipped) writer.u32(index).u8(reason);
  return writer.finish();
}

const TABLE: readonly ModuleCommandEntry[] = [
  { registration: 1, concurrency: 4, name: "python" }, { registration: 1, concurrency: 4, name: "python3" }, { registration: 2, concurrency: 1, name: "typst" },
];

describe("OXMC v1, the whole module-command table", () => {
  it("writes the version, the count and each entry's registration, concurrency and name in the given order", () => {
    expect(Array.from(encodeModuleCommandTable(TABLE))).toEqual([
      ...text("OXMC"), 1, 0, 0, 0, 3, 0, 0, 0,
      1, 0, 0, 0, 4, 0, 0, 0, 6, 0, 0, 0, ...text("python"),
      1, 0, 0, 0, 4, 0, 0, 0, 7, 0, 0, 0, ...text("python3"),
      2, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, ...text("typst"),
    ]);
    // An empty table is the request that removes every stub this VM owns.
    expect(Array.from(encodeModuleCommandTable([]))).toEqual([...text("OXMC"), 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("round-trips generated tables through the engine's reader", () => {
    for (let size = 0; size <= MODULE_COMMAND_MAX_NAMES; size += 7) {
      const table = Array.from({ length: size }, (_, index): ModuleCommandEntry => {
        const registration = 1 + (index % 5) * 977;
        return { registration, concurrency: 1 + registration % MODULE_COMMAND_MAX_CONCURRENCY, name: `c${String(index)}${"x".repeat(index % 60)}` };
      });
      expect(readTable(encodeModuleCommandTable(table))).toEqual(table);
    }
    const largest = [{ registration: 0xffff_ffff, concurrency: MODULE_COMMAND_MAX_CONCURRENCY, name: "z".repeat(64) }];
    expect(readTable(encodeModuleCommandTable(largest))).toEqual(largest);
  });

  it("refuses a table Rust would refuse before writing anything", () => {
    const entry = { registration: 1, concurrency: 4, name: "tool" };
    for (const table of [
      [{ ...entry, registration: 0 }], [{ ...entry, registration: -1 }], [{ ...entry, registration: 1.5 }], [{ ...entry, registration: 2 ** 32 }],
      [{ ...entry, concurrency: 0 }], [{ ...entry, concurrency: MODULE_COMMAND_MAX_CONCURRENCY + 1 }], [{ ...entry, concurrency: 2.5 }],
      [{ ...entry, name: "Tool" }], [{ ...entry, name: "oxidevm-tool" }], [{ ...entry, name: "" }],
      [entry, { ...entry, registration: 2 }],
      // Every name of one registration carries that registration's single limit.
      [entry, { ...entry, name: "other", concurrency: 5 }],
      Array.from({ length: MODULE_COMMAND_MAX_NAMES + 1 }, (_, index) => ({ ...entry, name: `c${String(index)}` })),
    ]) expect(() => encodeModuleCommandTable(table), JSON.stringify(table).slice(0, 80)).toThrow();
  });
});

describe("OXMA v1, what applying the table did", () => {
  it("decodes an applied table, whether the directory changed, and each skipped entry in request order", () => {
    expect(decodeModuleCommandApplication(oxma(), 3)).toEqual({ outcome: "applied", changed: false, skipped: [] });
    expect(decodeModuleCommandApplication(oxma({ changed: 1, skipped: [[0, 1], [2, 1]] }), 3)).toEqual({ outcome: "applied", changed: true, skipped: [{ entry: 0, reason: "occupied" }, { entry: 2, reason: "occupied" }] });
    expect(decodeModuleCommandApplication(oxma({ changed: 1 }), 0)).toEqual({ outcome: "applied", changed: true, skipped: [] });
  });

  it("decodes every refusal with the entry at fault and the errno of a filesystem failure", () => {
    expect(decodeModuleCommandApplication(oxma({ outcome: 1 }), 2)).toEqual({ outcome: "malformed", entry: null });
    expect(decodeModuleCommandApplication(oxma({ outcome: 1, entry: 1 }), 2)).toEqual({ outcome: "malformed", entry: 1 });
    expect(decodeModuleCommandApplication(oxma({ outcome: 2, entry: 0 }), 2)).toEqual({ outcome: "invalid-name", entry: 0 });
    expect(decodeModuleCommandApplication(oxma({ outcome: 3, entry: 1 }), 2)).toEqual({ outcome: "duplicate", entry: 1 });
    expect(decodeModuleCommandApplication(oxma({ outcome: 4, entry: 64 }), 65)).toEqual({ outcome: "too-many", entry: 64 });
    expect(decodeModuleCommandApplication(oxma({ outcome: 6 }), 2)).toEqual({ outcome: "directory-unavailable" });
    expect(decodeModuleCommandApplication(oxma({ outcome: 7 }), 2)).toEqual({ outcome: "busy" });
    expect(decodeModuleCommandApplication(oxma({ outcome: 8 }), 2)).toEqual({ outcome: "initial-user-root" });
    expect(decodeModuleCommandApplication(oxma({ outcome: 9, errno: 28 }), 2)).toEqual({ outcome: "filesystem", changed: false, entry: null, errno: 28 });
    // A reconciliation that fails part way says which entry failed and that the directory already changed.
    expect(decodeModuleCommandApplication(oxma({ outcome: 9, changed: 1, entry: 1, errno: 5 }), 2)).toEqual({ outcome: "filesystem", changed: true, entry: 1, errno: 5 });
  });

  it("round-trips every record the engine writes for generated requests", () => {
    for (let requested = 0; requested <= MODULE_COMMAND_MAX_NAMES; requested += 9) {
      const skipped = Array.from({ length: requested }, (_, index) => index).filter(index => index % 3 === 1).map(index => [index, 1] as const);
      for (const changed of [0, 1]) {
        expect(decodeModuleCommandApplication(oxma({ changed, skipped }), requested)).toEqual({ outcome: "applied", changed: changed === 1, skipped: skipped.map(([entry]) => ({ entry, reason: "occupied" })) });
      }
      for (let entry = 0; entry < requested; entry += 5) {
        expect(decodeModuleCommandApplication(oxma({ outcome: 2, entry }), requested)).toEqual({ outcome: "invalid-name", entry });
        expect(decodeModuleCommandApplication(oxma({ outcome: 9, changed: 1, entry, errno: 1 + entry }), requested)).toEqual({ outcome: "filesystem", changed: true, entry, errno: 1 + entry });
      }
    }
  });

  it("refuses malformed, extra and impossible fields", () => {
    for (const [bytes, requested] of [
      [oxma({ magic: "OXMC" }), 2], [oxma({ version: 0 }), 2], [oxma({ version: 2 }), 2],
      // Outcome 5 is unused: a path held by another file is skipped, not refused.
      [oxma({ outcome: 5 }), 2], [oxma({ outcome: 10 }), 2], [oxma({ outcome: 255 }), 2], [oxma({ changed: 2 }), 2],
      [oxma({ skipped: [[0, 0]] }), 2], [oxma({ skipped: [[0, 2]] }), 2], [oxma({ skipped: [[2, 1]] }), 2], [oxma({ skipped: [[1, 1], [0, 1]] }), 2], [oxma({ skipped: [[1, 1], [1, 1]] }), 2],
      [oxma({ entry: 0 }), 2], [oxma({ errno: 2 }), 2],
      [oxma({ outcome: 1, entry: 2 }), 2], [oxma({ outcome: 1, changed: 1 }), 2], [oxma({ outcome: 1, errno: 2 }), 2], [oxma({ outcome: 1, skipped: [[0, 1]] }), 2],
      [oxma({ outcome: 2 }), 2], [oxma({ outcome: 3 }), 2], [oxma({ outcome: 2, entry: 2 }), 2],
      [oxma({ outcome: 4, entry: 64 }), 64], [oxma({ outcome: 4, entry: 3 }), 65], [oxma({ outcome: 4 }), 65],
      [oxma({ outcome: 6, entry: 0 }), 2], [oxma({ outcome: 7, changed: 1 }), 2], [oxma({ outcome: 8, errno: 1 }), 2],
      [oxma({ outcome: 9 }), 2], [oxma({ outcome: 9, errno: 4096 }), 2], [oxma({ outcome: 9, errno: 5, entry: 2 }), 2], [oxma({ outcome: 9, errno: 5, skipped: [[0, 1]] }), 2],
      [oxma().subarray(0, -1), 2], [new Uint8Array(), 2],
    ] as const) expect(() => decodeModuleCommandApplication(bytes, requested), `${String(requested)}:${Array.from(bytes).join(",")}`).toThrow();
    const trailing = new Uint8Array(oxma().byteLength + 1); trailing.set(oxma());
    expect(() => decodeModuleCommandApplication(trailing, 2)).toThrow(/Unexpected/u);
    for (const requested of [-1, 1.5, 2 ** 32]) expect(() => decodeModuleCommandApplication(oxma(), requested)).toThrow();
  });
});
