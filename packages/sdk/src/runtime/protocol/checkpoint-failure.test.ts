import { expect, it } from "vitest";
import { checkpointFailureSummary, decodeCheckpointFailureSummary } from "./checkpoint-failure.js";

const rejected = { reason: "checkpoint-begin-rejected", phase: "initial-round", domain: "runtime", owner: "files", nativeReason: 4, scalar0: 0, scalar1: 0, nativeCauses: ["not-quiesced"] };

it("summarizes a rejected checkpoint begin from its error detail", () => {
  expect(checkpointFailureSummary(rejected)).toEqual({ phase: "initial-round", domain: "runtime", owner: "files", causes: ["not-quiesced"] });
});

it("summarizes a rejection outside the runtime owners without an owner", () => {
  expect(checkpointFailureSummary({ reason: "checkpoint-begin-rejected", phase: "quiesce", domain: "codec", nativeReason: 2, scalar0: 0, scalar1: 0 }))
    .toEqual({ phase: "quiesce", domain: "codec", causes: [] });
});

it("has no summary for other failures or malformed detail", () => {
  expect(checkpointFailureSummary({ reason: "snapshot-process-exited", process: "services" })).toBeUndefined();
  expect(checkpointFailureSummary(undefined)).toBeUndefined();
  expect(checkpointFailureSummary({ ...rejected, phase: "invented" })).toBeUndefined();
  expect(checkpointFailureSummary({ ...rejected, owner: "private/path" })).toBeUndefined();
  expect(checkpointFailureSummary({ ...rejected, nativeCauses: ["not quiesced; rm -rf"] })).toBeUndefined();
});

it("decodes a summary exactly and rejects unknown fields and values", () => {
  const summary = { phase: "initial-round", domain: "runtime", owner: "files", causes: ["not-quiesced"] };
  expect(decodeCheckpointFailureSummary(summary)).toEqual(summary);
  for (const bad of [{ ...summary, extra: 1 }, { ...summary, domain: "kernel" }, { ...summary, causes: "not-quiesced" }, { ...summary, causes: Array(10).fill("bounds") }]) {
    expect(() => decodeCheckpointFailureSummary(bad)).toThrow();
  }
});
