import { expect, it } from "vitest";
import { coreFailureError } from "./core-failure.ts";

it("worker errors retain entropy failures instead of reporting an unsupported instruction", () => {
  const failure = { kind: "entropy-replay", reason: "replay-mismatch" } as const;
  const error = coreFailureError({ kind: "internal-failure", steps: 7n, failure });
  expect(error.code).toBe("VM_FAULT");
  expect(error.detail).toEqual({ coreSteps: "7", failure });
  expect(error.message).toContain("replay-mismatch");
});

it("worker errors preserve unsupported and adapter failure families and historical absence", () => {
  expect(coreFailureError({ kind: "internal-failure", steps: 0n, failure: { kind: "unsupported-semantic" } }).code).toBe("UNSUPPORTED_INSTRUCTION");
  expect(coreFailureError({ kind: "internal-failure", steps: 0n, failure: { kind: "unexpected-adapter-exit" } }).code).toBe("VM_FAULT");
  expect(coreFailureError({ kind: "internal-failure", steps: 0n }).detail).toEqual({ coreSteps: "0" });
});
