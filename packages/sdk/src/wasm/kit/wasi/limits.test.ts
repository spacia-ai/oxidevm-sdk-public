import { describe, expect, it } from "vitest";
import { mapGuestExit } from "./exit.js";
import { encodeLaunch, LaunchError } from "./preview1.js";
import { LIMITS } from "./limits.js";

describe("guest exit codes (OBL-EXIT)", () => {
  it("keeps 0..119 exact", () => {
    for (const code of [0, 1, 119]) expect(mapGuestExit(code, "tool")).toEqual({ status: code });
  });

  it("reports 120 and above as status 1 with the original code, never as an SDK status", () => {
    for (const code of [120, 125, 255, 0xffff_ffff]) {
      const mapped = mapGuestExit(code, "tool");
      expect(mapped.status).toBe(1);
      expect(mapped.diagnostic).toContain(`status ${String(code)}`);
    }
  });
});

describe("launch bounds (OBL-ENV-LIMIT)", () => {
  // Each string carries one NUL terminator, so a value of n bytes takes n + 1.
  it("accepts argv of exactly 64 KiB and refuses one byte more", () => {
    expect(() => encodeLaunch(["a".repeat(LIMITS.launchBytes - 1)], {})).not.toThrow();
    expect(() => encodeLaunch(["a".repeat(LIMITS.launchBytes)], {})).toThrow(LaunchError);
  });

  it("bounds the environment separately, counting KEY=VALUE", () => {
    expect(() => encodeLaunch(["tool"], { K: "v".repeat(LIMITS.launchBytes - 3) })).not.toThrow();
    expect(() => encodeLaunch(["tool"], { K: "v".repeat(LIMITS.launchBytes - 2) })).toThrow(/environment exceeds/u);
  });

  it("refuses an embedded NUL in an argument or a value", () => {
    expect(() => encodeLaunch(["a\0b"], {})).toThrow(/NUL/u);
    expect(() => encodeLaunch(["tool"], { K: "a\0" })).toThrow(/NUL/u);
  });

  it("keeps empty arguments, leading dashes, spaces and Unicode exact", () => {
    const { argv } = encodeLaunch(["tool", "", "--x", "two words", "zażółć"], { EMPTY: "" });
    expect(argv.map(bytes => new TextDecoder().decode(bytes))).toEqual(["tool\0", "\0", "--x\0", "two words\0", "zażółć\0"]);
  });
});
