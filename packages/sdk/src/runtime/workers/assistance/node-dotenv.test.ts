import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { createNodeUtil } from "./node-util.js";

const control = record(JSON.parse(readFileSync(new URL("./node-dotenv.controls.json", import.meta.url), "utf8")), "dotenv controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-dotenv.cjs", import.meta.url));
const nullPrototype: unknown = Object.create(null), stringObject: unknown = Object("A=1");
// The recorder's non-string arguments, by label.
const others = new Map<string, readonly unknown[]>([
  ["no-argument", []], ["undefined", [undefined]], ["null", [null]], ["number", [1]], ["negative-zero", [-0]], ["nan", [NaN]],
  ["bigint", [1n]], ["boolean", [true]], ["symbol", [Symbol("x")]], ["object", [{}]], ["array", [[]]], ["string-object", [stringObject]],
  ["null-prototype", [nullPrototype]], ["function", [function named() { /* a named function */ }]], ["buffer", [Buffer.from("A=1")]],
]);

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("parses .env content exactly as pinned Node's util.parseEnv, quirks, key order and argument errors included", () => {
  const util = createNodeUtil({ noDeprecation: false, emitWarning() {} });
  const parseEnv: unknown = Reflect.get(util, "parseEnv");
  if (typeof parseEnv !== "function") throw new Error("Missing util.parseEnv");
  expect({ name: parseEnv.name, length: parseEnv.length, prototype: typeof Reflect.get(parseEnv, "prototype") }).toEqual(control["function"]);
  const rows = control["rows"];
  if (!Array.isArray(rows) || rows.length !== 98) throw new Error("Incomplete dotenv controls");
  for (const value of rows) {
    const row = record(value, "dotenv control"), label = row["label"], input = row["input"];
    if (typeof label !== "string") throw new Error("Unlabelled dotenv control");
    const args = typeof input === "string" ? [input] : others.get(label);
    if (args === undefined) throw new Error(`Unknown dotenv input ${label}`);
    let actual: Record<string, unknown>;
    try {
      const result = record(Reflect.apply(parseEnv, undefined, args), "parseEnv result");
      actual = { label, input, entries: Object.entries(result), keys: Reflect.ownKeys(result).length, plain: Object.getPrototypeOf(result) === Object.prototype };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code: unknown = Reflect.get(error, "code");
      actual = { label, error: { name: error.name, code, message: error.message } };
    }
    expect(actual, label).toEqual(row);
  }
});
