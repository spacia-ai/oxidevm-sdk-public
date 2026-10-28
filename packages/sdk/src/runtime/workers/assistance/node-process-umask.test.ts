import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { record } from "../../decode.js";
import { createProcessUmask } from "./node-process-umask.js";

it("queries Linux on each call and preserves the full unsigned setter input", () => {
  const call = vi.fn<(mask?: number) => number>().mockReturnValueOnce(0o022).mockReturnValueOnce(0o027).mockReturnValueOnce(0o027);
  const umask = createProcessUmask(call, "node", true);
  expect(umask()).toBe(0o022); expect(umask(undefined)).toBe(0o027); expect(umask(0xffff_ffff)).toBe(0o027);
  expect(call.mock.calls).toEqual([[undefined], [undefined], [0xffff_ffff]]);
});

it("keeps validation independent of application changes to number and regexp methods", () => {
  const call = vi.fn<(mask?: number) => number>().mockReturnValue(0o022);
  const umask = createProcessUmask(call, "node", true);
  const integer = vi.spyOn(Number, "isInteger").mockReturnValue(true);
  const parse = vi.spyOn(Number, "parseInt").mockReturnValue(0);
  const exec = vi.spyOn(RegExp.prototype, "exec").mockReturnValue(null);
  let rejected: unknown;
  try {
    try { umask(1.5); } catch (error) { rejected = error; }
    umask("077");
  } finally { exec.mockRestore(); parse.mockRestore(); integer.mockRestore(); }
  expect(rejected).toMatchObject({ name: "RangeError", code: "ERR_OUT_OF_RANGE" });
  expect(call.mock.calls).toEqual([[0o077]]);
});

const inputs = new Map<string, readonly unknown[]>([
  ["query", []], ["undefined", [undefined]], ["zero", [0]], ["one", [1]], ["777", [511]], ["1000", [512]], ["7777", [4095]],
  ["negative", [-1]], ["signed-max", [2147483647]], ["signed-high", [2147483648]], ["uint-max", [4294967295]], ["uint-overflow", [4294967296]],
  ["nan", [NaN]], ["infinity", [Infinity]], ["fraction", [1.5]], ["octal", ["022"]], ["octal-prefix", ["0o022"]], ["octal-max", ["777"]],
  ["octal-invalid", ["778"]], ["suffix", ["12junk"]], ["empty", [""]], ["null", [null]], ["boolean", [true]], ["object", [{}]], ["array", [[]]],
  ["bigint", [0n]], ["symbol", [Symbol("mask")]], ["set", [7]], ["invalid", [null]],
  ["space", [" 022"]], ["plus", ["+22"]], ["minus", ["-22"]], ["hex", ["0x22"]],
  ["octal-leading-zero", ["0000000000000022"]], ["octal-uint-max", ["37777777777"]], ["octal-overflow", ["40000000000"]],
  ["trailing-space", ["22 "]], ["tab", ["\t022"]], ["newline-plus", ["\n+22"]], ["negative-zero", ["-0"]], ["negative-zeros", ["-000"]],
  ["embedded-space", ["+\t22"]], ["unicode-space", ["\u00a022"]], ["invalid-leading-zero", ["0008"]], ["binary", ["0b10"]],
  ["final-newline", ["22\n"]], ["final-crlf", ["22\r\n"]],
]);

it.each(["node", "bun"] as const)("matches pinned %s validation and worker restrictions", runtime => {
  const control = record(JSON.parse(readFileSync(new URL("./node-process-umask.controls.json", import.meta.url), "utf8")), "umask controls");
  const expected = record(control[runtime], "runtime umask control");
  for (const isMainThread of [true, false]) {
    const rows: unknown = expected[isMainThread ? "rows" : "worker"];
    if (!Array.isArray(rows)) throw new TypeError("Missing umask cases");
    const values: readonly unknown[] = rows;
    for (const value of values) {
      const row = record(value, "umask case"), label = row["label"];
      if (typeof label !== "string") throw new TypeError("Missing umask case label");
      const args = inputs.get(label); if (args === undefined) throw new TypeError(`Unknown umask input ${label}`);
      const call = vi.fn<(mask?: number) => number>().mockReturnValue(23);
      let result: unknown;
      try {
        const returned: unknown = Reflect.apply(createProcessUmask(call, runtime, isMainThread), undefined, args);
        result = { returned };
      }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        const code: unknown = Reflect.get(error, "code");
        result = { error: { name: error.name, code, message: error.message } };
      }
      if (row["error"] === undefined) { expect(result, label).toEqual({ returned: 23 }); expect(call).toHaveBeenCalledOnce(); }
      else { expect(result, label).toEqual({ error: row["error"] }); expect(call).not.toHaveBeenCalled(); }
    }
  }
});
