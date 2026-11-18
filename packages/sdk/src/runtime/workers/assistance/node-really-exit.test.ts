import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { endNodeProcess, NodeProcess } from "./node-process.js";

const control = record(JSON.parse(readFileSync(new URL("./node-really-exit.controls.json", import.meta.url), "utf8")), "reallyExit controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-really-exit.cjs", import.meta.url));

class Terminated extends Error { constructor(readonly status: number) { super(`terminated ${String(status)}`); } }
type Scenario = (process: NodeProcess, log: (...values: unknown[]) => void, end: (how: "drained" | "uncaught", code?: number) => never) => void;
const really = (process: NodeProcess): ((code?: unknown) => unknown) => {
  const value: unknown = Reflect.get(process, "reallyExit");
  if (typeof value !== "function") throw new TypeError("no reallyExit");
  return (...args: unknown[]): unknown => Reflect.apply(value, process, args);
};
const patch = (process: NodeProcess, replacement: (this: unknown, code: unknown) => void): void => { Reflect.set(process, "reallyExit", replacement); };
/** The recorder's scenarios over the layer's process. The event loop's end is `end("drained")`; an uncaught error
 * reaches the process's listener, or ends it as uncaught. */
const scenarios: Readonly<Record<string, Scenario>> = {
  "descriptor": (process, log) => {
    const d = Object.getOwnPropertyDescriptor(process, "reallyExit"), value: unknown = d?.value;
    if (typeof value !== "function") throw new TypeError("no reallyExit");
    log(typeof value, d?.enumerable, d?.writable, d?.configurable, value.name, value.length); process.exitCode = 0;
  },
  "exit-calls-patched": (process, log) => { const o = really(process); patch(process, function (c) { log("patched", c, this === process, process.exitCode); o(c); }); process.on("exit", c => { log("exit", c); }); process.exit(3); },
  "direct-skips-exit-event": (process, log) => { process.on("exit", c => { log("exit", c); }); process.exitCode = 5; really(process)(7); log("after"); },
  "direct-no-argument": (process, log) => { process.on("exit", c => { log("exit", c); }); really(process)(); },
  "direct-string": process => { really(process)("9"); },
  "direct-wraps": process => { really(process)(260); },
  "direct-negative": process => { really(process)(-1); },
  "direct-fraction": process => { really(process)(3.9); },
  "natural-end-skips-patched": (process, log, end) => { const o = really(process); patch(process, c => { log("patched", c); o(c); }); process.on("exit", c => { log("exit", c); }); process.exitCode = 2; end("drained"); },
  "uncaught-skips-patched": (process, log, end) => {
    const o = really(process); patch(process, c => { log("patched", c); o(c); }); process.on("exit", c => { log("exit", c); });
    process.on("uncaughtException", () => { log("caught"); process.exitCode = 6; });
    process.emit("uncaughtException", new Error("boom")); end("drained");
  },
  "patched-returns": (process, log, end) => {
    patch(process, c => { log("patched", c); }); process.on("exit", c => { log("exit", c); });
    const exit: unknown = process.exit, value: unknown = typeof exit === "function" ? Reflect.apply(exit, process, [4]) : "missing"; log("continued", typeof value); log("timer"); end("drained");
  },
  "exit-twice": (process, log) => { let n = 0; const o = really(process); patch(process, c => { log("patched", c, ++n); if (n === 2) o(c); }); process.on("exit", c => { log("exit", c); }); process.exit(1); process.exit(8); },
};

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("has process.reallyExit and calls it from process.exit only, as pinned Node does", () => {
  const rows = control["rows"];
  if (!Array.isArray(rows) || rows.length !== Object.keys(scenarios).length) throw new Error("Scenario list differs from the controls");
  for (const value of rows) {
    const row = record(value, "scenario"), name = string(row["name"], "name"), scenario = scenarios[name];
    if (scenario === undefined) throw new Error(`No replica of ${name}`);
    const stdout: string[] = [];
    const process = new NodeProcess(code => { throw new Terminated(code); }, "24.18.1");
    const log = (...values: unknown[]): void => { stdout.push(values.map(item => typeof item === "string" ? item : JSON.stringify(item)).join(" ")); };
    let status: number | undefined;
    try { scenario(process, log, (how, code) => endNodeProcess(process, how, code)); endNodeProcess(process, "drained"); }
    catch (error) { if (!(error instanceof Terminated)) throw error; status = error.status; }
    expect({ name, stdout, status }).toEqual({ name, stdout: row["stdout"], status: row["status"] });
  }
});
