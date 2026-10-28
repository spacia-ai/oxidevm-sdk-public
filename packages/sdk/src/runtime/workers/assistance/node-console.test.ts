import { expect, it } from "vitest";
import { createNodeConsole } from "./node-console.js";

const format = (...values: unknown[]): string => values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ");

function sink() {
  const lines: { stream: "stdout" | "stderr"; text: string }[] = [];
  let now = 1000;
  const console = createNodeConsole((stream, text) => { lines.push({ stream, text }); }, format, () => now);
  return { console, lines, tick: (ms: number) => { now += ms; } };
}

/** Next's edge console binds these on the global console at load; a missing
 * one ended the dev server with "reading 'bind'". */
it("exposes every console method the edge runtime binds and Node's remaining surface", () => {
  const { console } = sink();
  for (const name of ["error", "log", "assert", "time", "timeEnd", "timeLog", "trace", "count", "dir",
    "info", "warn", "debug", "dirxml", "table", "countReset", "group", "groupCollapsed", "groupEnd", "timeStamp", "profile", "profileEnd", "clear"]) {
    expect(typeof Reflect.get(console, name), name).toBe("function");
  }
});

it("routes log, info, debug and dir to stdout and warn, error and trace to stderr", () => {
  const { console, lines } = sink();
  console.log("a", 1); console.info("b"); console.debug("c"); console.dir({ d: 1 });
  console.warn("w"); console.error("e");
  console.trace("t");
  expect(lines.slice(0, 6)).toEqual([
    { stream: "stdout", text: "a 1" }, { stream: "stdout", text: "b" }, { stream: "stdout", text: "c" }, { stream: "stdout", text: '{"d":1}' },
    { stream: "stderr", text: "w" }, { stream: "stderr", text: "e" },
  ]);
  expect(lines[6]?.stream).toBe("stderr");
  expect(lines[6]?.text.startsWith("Trace: t")).toBe(true);
});

it("asserts only when the condition is falsy", () => {
  const { console, lines } = sink();
  console.assert(true, "never");
  console.assert(false);
  console.assert(0, "detail", 2);
  expect(lines).toEqual([{ stream: "stderr", text: "Assertion failed" }, { stream: "stderr", text: "Assertion failed: detail 2" }]);
});

it("counts and times by label with Node's formats", () => {
  const { console, lines, tick } = sink();
  console.count(); console.count("x"); console.count(); console.countReset(); console.count();
  console.time("t"); tick(12.5); console.timeLog("t", "half"); tick(1237.5); console.timeEnd("t");
  console.timeEnd("missing");
  expect(lines.map(line => line.text)).toEqual([
    "default: 1", "x: 1", "default: 2", "default: 1",
    "t: 12.5ms half", "t: 1.250s",
    "Warning: No such label 't' for console.timeEnd()".replace("'t'", "'missing'"),
  ]);
  expect(lines[6]?.stream).toBe("stderr");
});

it("indents grouped output and stops at groupEnd", () => {
  const { console, lines } = sink();
  console.group("outer"); console.log("one"); console.groupCollapsed("inner"); console.log("two"); console.groupEnd(); console.log("three"); console.groupEnd(); console.log("four");
  expect(lines.map(line => line.text)).toEqual(["outer", "  one", "  inner", "    two", "  three", "four"]);
});
