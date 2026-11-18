import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import { record } from "../../decode.js";
import { createColorSupport } from "./tty-colors.js";

const control = record(JSON.parse(readFileSync(new URL("./tty-colors.controls.json", import.meta.url), "utf8")), "tty color controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-tty-colors.cjs", import.meta.url));
const original: unknown = Reflect.get(globalThis, "process");
afterEach(() => { Reflect.set(globalThis, "process", original); });

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("gives color depth and support exactly as pinned Node, warnings and argument errors included", () => {
  const warnings: [string, string][] = [];
  // The process runtime installs the program's process before any program code runs; the recorder ran with an empty environment.
  Reflect.set(globalThis, "process", { env: {}, emitWarning: (message: string, type: string) => { warnings.push([type, message]); } });
  const { getColorDepth, hasColors } = createColorSupport((value, options) => inspect(value, options));
  expect({ getColorDepth: [getColorDepth.name, getColorDepth.length], hasColors: [hasColors.name, hasColors.length] })
    .toEqual({ getColorDepth: record(control["shape"], "shape")["getColorDepth"], hasColors: record(control["shape"], "shape")["hasColors"] });
  const rows = control["rows"];
  if (!Array.isArray(rows) || rows.length !== 67) throw new Error("Incomplete tty color controls");
  for (const value of rows) {
    const row = record(value, "tty color control"), env = record(row["env"], "environment");
    const actual: Record<string, unknown> = { env, depth: getColorDepth(env) };
    for (const count of [2, 16, 256, 16777216, 16777217]) actual[`has${String(count)}`] = hasColors(count, env);
    actual["hasDefault"] = hasColors(env);
    expect(actual, JSON.stringify(env)).toEqual(row);
  }
  const errors: unknown[] = [];
  for (const [label, args] of [["string", ["16"]], ["one", [1]], ["fraction", [2.5]], ["negative", [-1]], ["nan", [NaN]], ["null", [null]]] as const) {
    try { errors.push({ label, result: hasColors(...args, {}) }); } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push({ label, error: { name: error.name, code: Object.hasOwn(error, "code") ? String(Reflect.get(error, "code") as unknown) : null, message: error.message } });
    }
  }
  expect(errors).toEqual(control["errors"]);
  expect(warnings).toEqual(control["warnings"]);
  expect(getColorDepth()).toBe(control["processDefault"]);
});
