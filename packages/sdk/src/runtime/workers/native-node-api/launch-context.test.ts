import { expect, it } from "vitest";
import { nativeArguments } from "./launch-context.js";

it("keeps execution flags separate from project arguments and rejects unqualified flags", () => {
  expect(nativeArguments(["node", "--enable-source-maps", "build.cjs", "--custom"])).toEqual({ entry: "build.cjs", execArgv: ["--enable-source-maps"], args: ["--custom"] });
  expect(() => nativeArguments(["node", "--require", "patch.cjs", "build.cjs"])).toThrow();
  expect(() => nativeArguments(["node", "--enable-source-maps", "--enable-source-maps", "build.cjs"])).toThrow();
});

it("retains the script spelling independently of its canonical code identity", () => {
  expect(nativeArguments(["node", "/usr/bin/npm", "run", "dev"]))
    .toEqual({ entry: "/usr/bin/npm", execArgv: [], args: ["run", "dev"] });
});
