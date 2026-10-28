import { expect, it } from "vitest";

import { decodeSystemHostAttentionProfile, emptySystemHostAttentionProfile, SYSTEM_ATTENTION_REASONS } from "./system-attention.js";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "./system-trace-schema.js";

it("records schema 54 host attention by reason", () => {
  expect(SYSTEM_TRACE_SCHEMA_VERSION).toBe(54);
  expect(Object.keys(emptySystemHostAttentionProfile().yields)).toEqual([...SYSTEM_ATTENTION_REASONS]);
  const profile = { yields: { control: 3, assistance: 1, "agent-response": 2 }, deferrals: 9 };
  expect(decodeSystemHostAttentionProfile(structuredClone(profile))).toEqual(profile);
});

it("rejects unknown reasons and malformed counts", () => {
  const profile = { yields: { control: 3, assistance: 1, "agent-response": 2 }, deferrals: 9 };
  expect(() => decodeSystemHostAttentionProfile({ ...profile, yields: { ...profile.yields, other: 1 } })).toThrow(/unexpected protocol field other/u);
  expect(() => decodeSystemHostAttentionProfile({ ...profile, deferrals: -1 })).toThrow(/deferrals/u);
  expect(() => decodeSystemHostAttentionProfile({ yields: profile.yields })).toThrow(/missing protocol field deferrals/u);
});
