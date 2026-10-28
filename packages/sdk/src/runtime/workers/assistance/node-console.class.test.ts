import { describe, expect, it } from "vitest";
import { Console } from "./node-console.js";
import { nodeUtil } from "./node-util.js";

describe("console.Console", () => {
  it("writes formatted lines to the given stdout and stderr streams", () => {
    const out: string[] = []; const err: string[] = [];
    const console = new Console({ stdout: { write: (text: string) => { out.push(text); return true; } }, stderr: { write: (text: string) => { err.push(text); return true; } } }, nodeUtil.format);
    console.log("a %d", 1);
    console.error("b");
    console.warn("c");
    expect(out).toEqual(["a 1\n"]);
    expect(err).toEqual(["b\n", "c\n"]);
    expect(() => new Console({}, nodeUtil.format)).toThrow(/stdout/u);
  });
});
