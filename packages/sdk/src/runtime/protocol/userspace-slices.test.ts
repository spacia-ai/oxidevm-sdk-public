import { describe, expect, it } from "vitest";

import { decodeUserspaceSliceProfile, emptyUserspaceSliceProfile, USERSPACE_ATTENTION_CHANNELS, USERSPACE_SLICE_ENDS } from "./userspace-slices.js";

const profile = {
  ends: { "action-budget": 0, deadline: 2, "compiled-module": 1, "interactive-output": 0, "host-attention": 5, boundary: 3, failure: 0 },
  hostAttention: { control: 4, "js-process": 1 },
  attentionDeferrals: 17,
  inlinePendingWorkPolls: 6,
};
const totals = { workerRunTurns: 11, pendingWorkPolls: 9 };

describe("Userspace slice profile", () => {
  it("names every slice end and attention channel once", () => {
    expect(new Set(USERSPACE_SLICE_ENDS).size).toBe(USERSPACE_SLICE_ENDS.length);
    expect(Object.keys(emptyUserspaceSliceProfile().ends)).toEqual([...USERSPACE_SLICE_ENDS]);
    expect(Object.keys(emptyUserspaceSliceProfile().hostAttention)).toEqual([...USERSPACE_ATTENTION_CHANNELS]);
  });

  it("decodes a profile whose ends sum to the run turns and whose attention sums to its end", () => {
    expect(decodeUserspaceSliceProfile(structuredClone(profile), totals)).toEqual(profile);
    expect(decodeUserspaceSliceProfile(emptyUserspaceSliceProfile(), { workerRunTurns: 0, pendingWorkPolls: 0 })).toEqual(emptyUserspaceSliceProfile());
  });

  it("rejects counters that do not reconcile", () => {
    expect(() => decodeUserspaceSliceProfile(profile, { ...totals, workerRunTurns: 12 })).toThrow(/do not reconcile/u);
    expect(() => decodeUserspaceSliceProfile({ ...profile, hostAttention: { control: 5, "js-process": 1 } }, totals)).toThrow(/do not reconcile/u);
    expect(() => decodeUserspaceSliceProfile(profile, { ...totals, pendingWorkPolls: 5 })).toThrow(/do not reconcile/u);
  });

  it("rejects unknown reasons, unknown channels and malformed counts", () => {
    expect(() => decodeUserspaceSliceProfile({ ...profile, ends: { ...profile.ends, other: 0 } }, totals)).toThrow(/unexpected protocol field other/u);
    expect(() => decodeUserspaceSliceProfile({ ...profile, hostAttention: { ...profile.hostAttention, storage: 0 } }, totals)).toThrow(/unexpected protocol field storage/u);
    expect(() => decodeUserspaceSliceProfile({ ...profile, attentionDeferrals: -1 }, totals)).toThrow(/attentionDeferrals/u);
    expect(() => decodeUserspaceSliceProfile({ ...profile, ends: { ...profile.ends, deadline: 1.5 } }, totals)).toThrow(/deadline/u);
  });
});
