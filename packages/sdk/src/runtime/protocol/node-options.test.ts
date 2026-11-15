import { expect, it } from "vitest";
import { nodeOptionsTokens, readNodeExecutionOptions, DEFAULT_NODE_EXECUTION_OPTIONS } from "./node-options.js";

// The same vectors as the engine's native_addon/node_options_tests.rs, which admits these launches.

it("splits NODE_OPTIONS on spaces and honors quotes and escapes inside them, as Node does", () => {
  expect(nodeOptionsTokens("  --no-warnings  -r dotenv/config ")).toEqual(["--no-warnings", "-r", "dotenv/config"]);
  expect(nodeOptionsTokens('--require "./a b.js"')).toEqual(["--require", "./a b.js"]);
  expect(nodeOptionsTokens('a""b "" c')).toEqual(["ab", "c"]);
  expect(nodeOptionsTokens(String.raw`"a\"b\\c"`)).toEqual([String.raw`a"b\c`]);
  // A backslash escapes only inside a string, and only spaces separate.
  expect(nodeOptionsTokens(String.raw`a\b`)).toEqual([String.raw`a\b`]);
  expect(nodeOptionsTokens("--no-warnings\t--no-deprecation")).toEqual(["--no-warnings\t--no-deprecation"]);
  expect(nodeOptionsTokens("")).toEqual([]);
  expect(nodeOptionsTokens('"unterminated')).toBeUndefined();
  expect(nodeOptionsTokens('"escape\\')).toBeUndefined();
});

it("reads the implemented execution options, takes their values as Node does and stops at the script", () => {
  const run = ["-r", "dotenv/config", "--require=./setup.cjs", "--require", "x", "-C", "development", "--conditions=worker", "--conditions", "edge",
    "--no-warnings", "--warnings", "--no-deprecation", "--deprecation", "--enable-source-maps", "--no-enable-source-maps", "--enable-source-maps", "server.js", "--no-warnings"];
  expect(readNodeExecutionOptions(run)).toEqual({ end: 17, options: { sourceMaps: true, warnings: true, deprecation: true, require: ["dotenv/config", "./setup.cjs", "x"], conditions: ["development", "worker", "edge"] } });
  expect(readNodeExecutionOptions(["--no-warnings", "--no-deprecation", "main.js"])?.options).toEqual({ ...DEFAULT_NODE_EXECUTION_OPTIONS, warnings: false, deprecation: false });
  expect(readNodeExecutionOptions(["main.js", "-r", "x"])).toEqual({ end: 0, options: DEFAULT_NODE_EXECUTION_OPTIONS });
  expect(readNodeExecutionOptions([])).toEqual({ end: 0, options: DEFAULT_NODE_EXECUTION_OPTIONS });
  // Options from NODE_OPTIONS come first; the command line applies over them.
  const environment = readNodeExecutionOptions(["-r", "first", "--no-warnings"]);
  expect(readNodeExecutionOptions(["-r", "second", "--warnings", "main.js"], environment?.options)?.options).toEqual({ ...DEFAULT_NODE_EXECUTION_OPTIONS, require: ["first", "second"] });
});

it("leaves every other or malformed option to Linux", () => {
  for (const run of [["--import", "tsx", "main.js"], ["--env-file=.env", "main.js"], ["--max-old-space-size=4096", "main.js"], ["--inspect", "main.js"], ["-e", "1"], ["--", "main.js"],
    ["-r"], ["-r", "-x", "main.js"], ["--require=", "main.js"], ["-r=x", "main.js"], ["-r", "", "main.js"], ["--warnings=false", "main.js"], ["--no-require", "x", "main.js"],
    ["--no_warnings", "main.js"], ["--enable_source_maps", "main.js"]]) {
    expect(readNodeExecutionOptions(run), run.join(" ")).toBeUndefined();
  }
});

it("gives Bun launches the source-map flags only", () => {
  expect(readNodeExecutionOptions(["--enable-source-maps", "--no-enable-source-maps", "main.js"], undefined, "bun")).toEqual({ end: 2, options: DEFAULT_NODE_EXECUTION_OPTIONS });
  for (const run of [["-r", "x", "main.js"], ["--no-warnings", "main.js"], ["-C", "dev", "main.js"]]) expect(readNodeExecutionOptions(run, undefined, "bun")).toBeUndefined();
});
