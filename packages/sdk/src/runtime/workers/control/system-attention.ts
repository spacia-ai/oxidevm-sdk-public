import { AttentionFairness, createAttentionCounter, HostAttention } from "../../host-attention.js";
import type { MutableSystemHostAttentionProfile, SystemAttentionReason } from "../../protocol/system-attention.js";
import { AttentionNotices, browserAttentionNoticesWorker, type AttentionNoticesWorker } from "../attention-notices.js";
import type { BrokerAttention } from "./assistance.js";

/**
 * Host attention for the System run loop (`../../protocol/system-attention.ts`). A slice ends at its
 * next deadline check when the page's control channel or an assistance broker holds messages the
 * control worker has not received, or when the guest agent answered a waiting host request during
 * the slice, once the guest has run its fair quantum.
 */
export class SystemAttention {
  readonly channels = new HostAttention<"control" | "assistance">();
  readonly #fairness = new AttentionFairness();
  readonly #startNotices: () => AttentionNoticesWorker;
  #notices: AttentionNotices | undefined;
  #quantum = 0;
  #responses = 0;

  constructor(startNotices: () => AttentionNoticesWorker = browserAttentionNoticesWorker) {
    this.#startNotices = startNotices;
  }

  /** A counted channel for an assistance broker on the execution origin, which cannot share memory
   * with this worker: it sends a notice per message to the attention notices worker instead. */
  openBrokerAttention(): BrokerAttention | undefined {
    const counter = createAttentionCounter();
    if (counter === null) return undefined;
    const notices = (this.#notices ??= new AttentionNotices(this.#startNotices)).open(counter);
    if (notices === undefined) return undefined;
    const watch = this.channels.watch("assistance", counter);
    return { port: notices.port, delivered: () => { watch.delivered(); }, close: () => { watch.close(); notices.release(); } };
  }

  /** A slice starts at `now`; `responses` counts the guest agent's answers so far. */
  begin(now: number, responses: number): void {
    this.#quantum = this.#fairness.begin(now);
    this.#responses = responses;
  }

  /** At a deadline check `elapsed` into the slice: whether host attention ends the slice now. */
  endsSlice(profile: MutableSystemHostAttentionProfile, elapsed: number, responses: number): boolean {
    const reason: SystemAttentionReason | undefined = this.channels.pending()
      ?? (responses !== this.#responses ? "agent-response" : undefined);
    if (reason === undefined) return false;
    if (elapsed < this.#quantum) {
      profile.deferrals += 1;
      return false;
    }
    profile.yields[reason] += 1;
    return true;
  }

  /** The slice ended at `now`; `runnable` when the guest still has work and runs again. */
  end(now: number, runnable: boolean): void {
    this.#fairness.end(now, runnable);
  }
}
