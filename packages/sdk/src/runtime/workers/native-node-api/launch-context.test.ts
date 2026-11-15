import { expect, it } from "vitest";
import { nativeArguments } from "./launch-context.js";

it("keeps execution flags separate from project arguments and rejects unqualified flags", () => {
  expect(nativeArguments(["node", "--enable-source-maps", "build.cjs", "--custom"])).toEqual({ entry: "build.cjs", execArgv: ["--enable-source-maps"], args: ["--custom"] });
  expect(() => nativeArguments(["node", "--import", "hook.mjs", "build.cjs"])).toThrow();
  expect(() => nativeArguments(["node", "--require", "patch.cjs"])).toThrow();
});

it("carries the implemented execution options of a Node launch, and source-map flags only for Bun (ADR 0026, 1.11)", () => {
  expect(nativeArguments(["node", "-r", "dotenv/config", "--no-warnings", "-C", "dev", "--enable-source-maps", "--enable-source-maps", "server.js", "-r", "x"]))
    .toEqual({ entry: "server.js", execArgv: ["-r", "dotenv/config", "--no-warnings", "-C", "dev", "--enable-source-maps", "--enable-source-maps"], args: ["-r", "x"] });
  expect(nativeArguments(["bun", "--enable-source-maps", "server.js"], "bun")).toEqual({ entry: "server.js", execArgv: ["--enable-source-maps"], args: [] });
  expect(() => nativeArguments(["bun", "-r", "x", "server.js"], "bun")).toThrow();
});

it("retains the script spelling independently of its canonical code identity", () => {
  expect(nativeArguments(["node", "/usr/bin/npm", "run", "dev"]))
    .toEqual({ entry: "/usr/bin/npm", execArgv: [], args: ["run", "dev"] });
});
