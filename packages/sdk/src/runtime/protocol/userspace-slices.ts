import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";

/**
 * How the Userspace worker's run slices ended (worker protocol 166). The worker serves its message
 * queue only between slices, so these counters show how quickly host messages could be served and
 * at what cost to the guest.
 */

/** The Userspace worker's channels whose producers count their posts (`../host-attention.ts`):
 * `control` carries the page's requests through the control worker's relay (workspace files,
 * terminal input, signals and process lifecycle), and `js-process` a JS process's Linux
 * operations, from a same-origin worker's mailbox count or a native process's broker notices. */
export const USERSPACE_ATTENTION_CHANNELS = ["control", "js-process"] as const;
export type UserspaceAttentionChannel = (typeof USERSPACE_ATTENTION_CHANNELS)[number];

/**
 * Why a run slice ended, one reason per slice: its actions or time ran out, a compiled module was
 * ready, an interactive slice produced output, a watched channel held host messages, the guest
 * reached a true boundary (blocked, exited or faulted), or the slice failed.
 */
export const USERSPACE_SLICE_ENDS = [
  "action-budget",
  "deadline",
  "compiled-module",
  "interactive-output",
  "host-attention",
  "boundary",
  "failure",
] as const;
export type UserspaceSliceEnd = (typeof USERSPACE_SLICE_ENDS)[number];

export interface UserspaceSliceProfile {
  /** Slices by end reason; they sum to the profile's `workerRunTurns`. */
  readonly ends: Record<UserspaceSliceEnd, number>;
  /** `host-attention` ends by the channel that held undelivered messages; they sum to that reason. */
  readonly hostAttention: Record<UserspaceAttentionChannel, number>;
  /** Action boundaries at which attention waited for the guest's quantum (`AttentionFairness`). */
  attentionDeferrals: number;
  /** Pending-work polls between actions of a running slice, a subset of `pendingWorkPolls`. */
  inlinePendingWorkPolls: number;
}

export function emptyUserspaceSliceProfile(): UserspaceSliceProfile {
  return {
    ends: { "action-budget": 0, deadline: 0, "compiled-module": 0, "interactive-output": 0, "host-attention": 0, boundary: 0, failure: 0 },
    hostAttention: { control: 0, "js-process": 0 },
    attentionDeferrals: 0,
    inlinePendingWorkPolls: 0,
  };
}

/** Decodes a slice profile and checks it against its execution profile's turn and poll counts. */
export function decodeUserspaceSliceProfile(
  value: unknown,
  totals: { readonly workerRunTurns: number; readonly pendingWorkPolls: number },
): UserspaceSliceProfile {
  const profile = record(value, "Userspace slice profile");
  exactKeys(profile, ["ends", "hostAttention", "attentionDeferrals", "inlinePendingWorkPolls"]);
  const endCounts = record(profile["ends"], "Userspace slice ends");
  exactKeys(endCounts, USERSPACE_SLICE_ENDS);
  const channelCounts = record(profile["hostAttention"], "Userspace slice host attention");
  exactKeys(channelCounts, USERSPACE_ATTENTION_CHANNELS);
  const count = (input: unknown, label: string) => integer(input, `Userspace slice ${label}`, 0);
  const decoded: UserspaceSliceProfile = {
    ends: {
      "action-budget": count(endCounts["action-budget"], "action-budget"),
      deadline: count(endCounts["deadline"], "deadline"),
      "compiled-module": count(endCounts["compiled-module"], "compiled-module"),
      "interactive-output": count(endCounts["interactive-output"], "interactive-output"),
      "host-attention": count(endCounts["host-attention"], "host-attention"),
      boundary: count(endCounts["boundary"], "boundary"),
      failure: count(endCounts["failure"], "failure"),
    },
    hostAttention: {
      control: count(channelCounts["control"], "control attention"),
      "js-process": count(channelCounts["js-process"], "js-process attention"),
    },
    attentionDeferrals: count(profile["attentionDeferrals"], "attentionDeferrals"),
    inlinePendingWorkPolls: count(profile["inlinePendingWorkPolls"], "inlinePendingWorkPolls"),
  };
  const ends = USERSPACE_SLICE_ENDS.reduce((sum, end) => sum + decoded.ends[end], 0);
  const attention = USERSPACE_ATTENTION_CHANNELS.reduce((sum, channel) => sum + decoded.hostAttention[channel], 0);
  if (ends !== totals.workerRunTurns || attention !== decoded.ends["host-attention"]
    || decoded.inlinePendingWorkPolls > totals.pendingWorkPolls) {
    throw new VMError("PROTOCOL_ERROR", "Userspace slice counters do not reconcile");
  }
  return decoded;
}
