import { expect, it } from "vitest";
import { decodeUserspaceJitProfile } from "./userspace-jit-profile.js";
import { emptyInterpreterReasonProfiles } from "./system-trace-legacy.js";
import { emptyInterpretedActionReasonProfiles } from "./system-trace-interpreted-actions.js";

const fixture = () => ({ version: 1, runtimeKey: "runtime:fixture", instructionProfiling: false, modules: [], droppedModules: 0, collidingModules: 0,
  operationSamples: [], droppedOperationSamples: 0, operationSampleTotal: 0, operationSamplePeriod: 64,
  interpreterReasons: emptyInterpreterReasonProfiles(), interpretedActionReasons: emptyInterpretedActionReasonProfiles() });
it("retains VM identity and typed fallback counts without inventing guest instruction samples", () => {
  const value = fixture();
  expect(decodeUserspaceJitProfile(value)).toEqual(value);
});
it("rejects unknown versions, unbounded records and malformed fallback reasons", () => {
  const value = fixture();
  for (const input of [{ ...value, version: 2 }, { ...value, extra: true }, { ...value, runtimeKey: "" }, { ...value, droppedModules: -1 },
    { ...value, operationSampleTotal: 1 }, { ...value, operationSamples: Array.from({ length: 8193 }, () => ({})) },
    { ...value, modules: Array.from({ length: 4097 }, () => ({})) }, { ...value, interpreterReasons: { ...value.interpreterReasons, other: { instructions: 0n, batches: 0, milliseconds: 0 } } }]) {
    expect(() => decodeUserspaceJitProfile(input)).toThrow();
  }
});
