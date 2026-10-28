import { decodeSystemTraceSchemaVersion } from "./system-trace-schema.js";
import { describe, expect, it } from "vitest";

import { jitInterpretReason } from "../core-abi/jit.js";
import { VMError } from "../errors.js";
import { SYSTEM_INTERPRETED_ACTION_REASONS } from "./system.js";
import { decodeInterpretedActionReasonProfiles, emptyInterpretedActionReasonProfiles } from "./system-trace-interpreted-actions.js";

const profiles = Object.fromEntries(SYSTEM_INTERPRETED_ACTION_REASONS.map(reason => [reason, { batches: 0, instructions: 0n }]));
/** Before schema 44 no action is interpreted while its module compiles. */
const legacyProfiles = Object.fromEntries(
  Object.entries(profiles).filter(([reason]) => !["compile-pending", "code-page-fault", "performance-overflow-boundary", "pending-virtual-interrupt"].includes(reason)),
);

describe("interpreted action reasons", () => {
  it("names every reason the core reports for an interpreted action", () => {
    const decoded = Array.from({ length: 18 }, (_, index) => jitInterpretReason(index + 1));
    expect(decoded).toEqual([...SYSTEM_INTERPRETED_ACTION_REASONS]);
    expect(jitInterpretReason(19)).toBeNull();
  });

  it("decodes the v36 per-reason batches and instructions exactly", () => {
    const value = { ...legacyProfiles, "missing-code-identity": { batches: 3, instructions: 18_000n } };
    expect(decodeInterpretedActionReasonProfiles(value, 36))
      .toEqual({ ...profiles, ...value, "compile-pending": { batches: 0, instructions: 0n }, "code-page-fault": { batches: 0, instructions: 0n } });
    expect(emptyInterpretedActionReasonProfiles()).toEqual(profiles);
  });

  it("carries compile-pending actions from schema 44 only", () => {
    const value = { ...legacyProfiles, "performance-overflow-boundary": { batches: 0, instructions: 0n }, "pending-virtual-interrupt": { batches: 0, instructions: 0n }, "compile-pending": { batches: 2, instructions: 8_192n } };
    expect(decodeInterpretedActionReasonProfiles(value, 44)).toEqual({ ...value, "code-page-fault": { batches: 0, instructions: 0n } });
    expect(() => decodeInterpretedActionReasonProfiles(value, 43)).toThrow(VMError);
    expect(() => decodeInterpretedActionReasonProfiles(legacyProfiles, 44)).toThrow(VMError);
  });

  it("carries code-page faults from schema 49 and retains main's older reason sets", () => {
    const value = { ...profiles, "code-page-fault": { batches: 1, instructions: 1n } };
    expect(decodeInterpretedActionReasonProfiles(value, 49)).toEqual(value);
    expect(() => decodeInterpretedActionReasonProfiles(value, 48)).toThrow(VMError);
    const { "code-page-fault": omitted, ...older } = value;
    expect(omitted.batches).toBe(1);
    expect(decodeInterpretedActionReasonProfiles(older, 48)).toEqual(profiles);
    expect(() => decodeInterpretedActionReasonProfiles(older, 49)).toThrow(VMError);
  });

  it("rejects missing or extra reasons, malformed counts and pre-v36 evidence", () => {
    const { halted, ...missing } = legacyProfiles;
    expect(halted).toBeDefined();
    expect(() => decodeInterpretedActionReasonProfiles(missing, 36)).toThrow(VMError);
    expect(() => decodeInterpretedActionReasonProfiles({ ...legacyProfiles, extra: { batches: 0, instructions: 0n } }, 36)).toThrow(VMError);
    expect(() => decodeInterpretedActionReasonProfiles({ ...legacyProfiles, halted: { batches: -1, instructions: 0n } }, 36)).toThrow(VMError);
    expect(() => decodeInterpretedActionReasonProfiles({ ...legacyProfiles, halted: { batches: 0, instructions: 5 } }, 36)).toThrow(VMError);
    expect(() => decodeInterpretedActionReasonProfiles(legacyProfiles, 35)).toThrow(VMError);
  });
});

it("qualifies pending virtual interrupt attribution only in schema 47 and later", () => {
  const current = { ...emptyInterpretedActionReasonProfiles(),
    "pending-virtual-interrupt": { batches: 1, instructions: 0n },
  };
  expect(decodeInterpretedActionReasonProfiles(current, decodeSystemTraceSchemaVersion(47))).toMatchObject({
    "pending-virtual-interrupt": { batches: 1, instructions: 0n },
  });
  expect(() => decodeInterpretedActionReasonProfiles(current, 46)).toThrow();
  const historical = Object.fromEntries(Object.entries(current).filter(([reason]) => reason !== "pending-virtual-interrupt"));
  expect(decodeInterpretedActionReasonProfiles(historical, 46)).toMatchObject({
    "pending-virtual-interrupt": { batches: 0, instructions: 0n },
  });
  expect(() => decodeInterpretedActionReasonProfiles(historical, decodeSystemTraceSchemaVersion(47))).toThrow();
});

it("initializes the new PMU reason to zero in archived trace schemas", () => {
  const current = emptyInterpretedActionReasonProfiles();
  const historical = Object.fromEntries(Object.entries(current).filter(([reason]) => reason !== "performance-overflow-boundary"));
  expect(decodeInterpretedActionReasonProfiles(historical, 45)).toMatchObject({
    "performance-overflow-boundary": { batches: 0, instructions: 0n },
  });
  expect(() => decodeInterpretedActionReasonProfiles({ ...historical,
    "performance-overflow-boundary": { batches: 1, instructions: 1n },
  }, 45)).toThrow();
});
