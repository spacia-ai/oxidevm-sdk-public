import { exactKeys, integer, record } from "../decode.js";

/**
 * System trace schema 54: guest slices the control worker ended early to serve host work. The
 * control worker serves its message queue only between slices, so a page request waits for the
 * current slice, and a guest-agent reply that completes a page request waits for it to end too.
 * `control`: the page's control channel (`../host-attention.ts`) held messages the worker had not
 * received. `assistance`: so did an ADR 0012 assistance broker, counted through its notices.
 * `agent-response`: the guest agent answered a waiting host request during the slice.
 */
export const SYSTEM_ATTENTION_REASONS = ["control", "assistance", "agent-response"] as const;
export type SystemAttentionReason = (typeof SYSTEM_ATTENTION_REASONS)[number];

export interface SystemHostAttentionProfile {
  /** Slices ended early, by reason. */
  readonly yields: Readonly<Record<SystemAttentionReason, number>>;
  /** Deadline checks at which attention waited for the guest's quantum (`AttentionFairness`). */
  readonly deferrals: number;
}

export interface MutableSystemHostAttentionProfile {
  readonly yields: Record<SystemAttentionReason, number>;
  deferrals: number;
}

export function emptySystemHostAttentionProfile(): MutableSystemHostAttentionProfile {
  return { yields: { control: 0, assistance: 0, "agent-response": 0 }, deferrals: 0 };
}

export function decodeSystemHostAttentionProfile(value: unknown): SystemHostAttentionProfile {
  const profile = record(value, "system host attention profile");
  exactKeys(profile, ["yields", "deferrals"]);
  const yields = record(profile["yields"], "system host attention yields");
  exactKeys(yields, SYSTEM_ATTENTION_REASONS);
  return {
    yields: {
      control: integer(yields["control"], "system control attention yields", 0),
      assistance: integer(yields["assistance"], "system assistance attention yields", 0),
      "agent-response": integer(yields["agent-response"], "system agent-response attention yields", 0),
    },
    deferrals: integer(profile["deferrals"], "system host attention deferrals", 0),
  };
}
