import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record } from "../decode.js";
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
  for (const run of [["--import", "tsx", "main.js"], ["--max-old-space-size=4096", "main.js"], ["--inspect", "main.js"], ["-e", "1"], ["--", "main.js"],
    ["-r"], ["-r", "-x", "main.js"], ["--require=", "main.js"], ["-r=x", "main.js"], ["-r", "", "main.js"], ["--warnings=false", "main.js"], ["--no-require", "x", "main.js"],
    ["--no_warnings", "main.js"], ["--enable_source_maps", "main.js"]]) {
    expect(readNodeExecutionOptions(run), run.join(" ")).toBeUndefined();
  }
});

it("gives Bun launches the source-map flags only", () => {
  expect(readNodeExecutionOptions(["--enable-source-maps", "--no-enable-source-maps", "main.js"], undefined, "bun")).toEqual({ end: 2, options: DEFAULT_NODE_EXECUTION_OPTIONS });
  for (const run of [["-r", "x", "main.js"], ["--no-warnings", "main.js"], ["-C", "dev", "main.js"]]) expect(readNodeExecutionOptions(run, undefined, "bun")).toBeUndefined();
});

/** One value of the shared vectors: percent-decoded bytes, `~` alone being empty. */
function vectorValue(field: string): string {
  if (field === "~") return "";
  return Buffer.from(field.replace(/%([0-9A-F]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1").toString("utf8");
}
const vectorList = (field: string): string[] => field === "" ? [] : field.split(" ").map(vectorValue);

it("holds the option vectors the engine replays too, from the copy pinned to the engine's file", () => {
  const source = record(JSON.parse(readFileSync(new URL("../../../../../config/node-options-source.json", import.meta.url), "utf8")), "option vector source");
  const files = source["files"];
  if (!Array.isArray(files) || files.length !== 1) throw new Error("The option vector source names one file");
  const pinned = record(files[0], "pinned vector file");
  const bytes = readFileSync(new URL("./node-options.vectors.tsv", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned["sha256"]);
  let tokens = 0, options = 0;
  for (const line of bytes.toString("utf8").split("\n").filter(text => text !== "" && !text.startsWith("#"))) {
    const fields = line.split("\t");
    if (fields[0] === "token" && fields.length === 3) {
      expect(nodeOptionsTokens(vectorValue(fields[1] ?? "")), line).toEqual(fields[2] === "!refused" ? undefined : vectorList(fields[2] ?? ""));
      tokens++;
    } else if (fields[0] === "option" && fields.length === 4 && (fields[1] === "node" || fields[1] === "bun" || fields[1] === "node-options")) {
      const read = fields[1] === "node-options" ? readNodeExecutionOptions(vectorList(fields[3] ?? ""), undefined, "node", "node-options")
        : readNodeExecutionOptions(vectorList(fields[3] ?? ""), undefined, fields[1]);
      expect(read?.end, line).toBe(fields[2] === "!refused" ? undefined : Number(fields[2]));
      options++;
    } else throw new Error(`Malformed vector line: ${line}`);
  }
  expect(tokens).toBeGreaterThanOrEqual(10);
  expect(options).toBeGreaterThanOrEqual(25);
});
