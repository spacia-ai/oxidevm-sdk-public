import { readFileSync } from "node:fs";
import { record } from "../../decode.js";
import { expect, it } from "vitest";
import { createNodeUtil } from "./node-util.js";

it("exports styleText for ordinary pipe output and explicit ANSI styling", () => {
  const util = createNodeUtil({ noDeprecation: false, emitWarning() {} });
  const style: unknown = Reflect.get(util, "styleText");
  expect(typeof style).toBe("function");
  if (typeof style !== "function") throw new Error("Missing util.styleText");
  expect(Reflect.apply(style, undefined, ["red", "text", { validateStream: false }])).toBe("\u001b[31mtext\u001b[39m");
  expect(Reflect.apply(style, undefined, [["bold", "red"], "text", { validateStream: false }])).toBe("\u001b[1m\u001b[31mtext\u001b[39m\u001b[22m");
  expect(Reflect.apply(style, undefined, ["#1aF", "text", { validateStream: false }])).toBe("\u001b[38;2;17;170;255mtext\u001b[39m");
  expect(() => { Reflect.apply(style, undefined, ["invalid", "text", { validateStream: false }]); }).toThrow();
});


it("matches retained Node 24.18.1 values and error metadata", () => {
  const control = record(JSON.parse(readFileSync(new URL("./node-util-style.node24.json", import.meta.url), "utf8")), "Node style controls");
  expect(control["node"]).toBe("v24.18.1");
  const util = createNodeUtil({ noDeprecation: false, emitWarning() {}, stdout: { write() {}, on() {} } });
  expect(Object.getOwnPropertyNames(Reflect.get(util.inspect, "colors"))).toEqual(control["colors"]);
  const input = control["rows"]; if (!Array.isArray(input)) throw new TypeError("Invalid style control cases");
  const cases: readonly unknown[] = input; expect(cases.length).toBe(13);
  for (const value of cases) {
    const row = record(value, "style control"); let result: unknown;
    try { result = { value: util.styleText(row["format"], row["text"], row["options"]) }; }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      const code: unknown = Reflect.get(error, "code");
      result = { error: { name: error.name, code, message: error.message } };
    }
    expect(result).toEqual(row["error"] === undefined ? { value: row["value"] } : { error: row["error"] });
  }
});

it("uses the selected stream and process color controls", () => {
  const env: Record<string, string | undefined> = {};
  const output = { write() {}, on() {}, isTTY: false, getColorDepth() { return 1; } };
  const util = createNodeUtil({ noDeprecation: false, emitWarning() {}, stdout: output, env });
  expect(util.styleText("red", "x")).toBe("x");
  env["FORCE_COLOR"] = "1";
  expect(util.styleText("red", "x")).toBe("\u001b[31mx\u001b[39m");
  env["FORCE_COLOR"] = "0";
  expect(util.styleText("red", "x", { stream: { write() {}, on() {}, isTTY: true } })).toBe("x");
  delete env["FORCE_COLOR"];
  expect(util.styleText("red", "x", { stream: { write() {}, on() {}, isTTY: true } })).toBe("\u001b[31mx\u001b[39m");
  expect(util.styleText("red", "x", { stream: new WritableStream() })).toBe("x");
});
