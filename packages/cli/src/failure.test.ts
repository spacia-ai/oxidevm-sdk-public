import { expect, it } from "vitest";
import { VMError } from "@oxidevm/sdk";
import { failureMessage } from "./failure.js";

it("keeps a typed SDK error's own message", () => {
  expect(failureMessage(new VMError("INVALID_ARGUMENT", "bad flag"))).toBe("bad flag");
});

it("names only the errno of a system error, never its path or text", () => {
  const error = Object.assign(new Error("ENOSPC: no space left on device, write '/home/someone/project/out.bin'"), { code: "ENOSPC" });
  const message = failureMessage(error);
  expect(message).toBe("operation failed (ENOSPC); check the selected files and installed tools");
  expect(message).not.toContain("someone");
});

it("stays generic for anything without a well-formed errno", () => {
  for (const error of [new Error("boom"), Object.assign(new Error("x"), { code: "not an errno" }), Object.assign(new Error("x"), { code: 28 }), "text", undefined]) {
    expect(failureMessage(error)).toBe("operation failed; check the selected files and installed tools");
  }
});
