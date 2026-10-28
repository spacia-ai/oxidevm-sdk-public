import { VMError } from "../../errors.js";
import type { AutoSaveHint, SnapshotEventRecord } from "../../protocol.js";

/** Saves while the guest runs this often... */
const INTERVAL_MILLISECONDS = 2 * 60_000;
/** ...and, while saves pause the guest too long, this rarely at most. */
const MAX_INTERVAL_MILLISECONDS = 15 * 60_000;
/** A burst of activity is saved once it has been quiet this long. */
const ACTIVITY_DEBOUNCE_MILLISECONDS = 10_000;
/** No automatic save starts this soon after a keystroke. */
const TYPING_GUARD_MILLISECONDS = 2_000;
/** Saves start at least this far apart... */
const MIN_SPACING_MILLISECONDS = 20_000;
/** ...and at least this many times the last save's duration apart. */
const SPACING_FACTOR = 20;
/** The guest may pause this long per save at p95 over the last saves before saves thin out. */
const PAUSE_BUDGET_MILLISECONDS = 250;
const PAUSE_WINDOW = 5;
const QUOTA_RETRY_MILLISECONDS = 60_000;
const MAX_QUOTA_RETRY_MILLISECONDS = 30 * 60_000;

export interface AutoSavePolicy {
  readonly enabled: boolean;
}

/** Automatic saves stopped for lack of space; they try again after `retryInMilliseconds`. */
export type AutoSaveEvent = Extract<SnapshotEventRecord, { readonly type: "auto-save-paused" }>;

/** What automatic saves use of the control worker. */
export interface AutoSaveHost {
  readonly prepare?: (signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** Runs `run` after `delay` milliseconds; the result cancels it. */
  readonly schedule: (delay: number, run: () => void) => () => void;
  /** Whether the guest ran since the last save. */
  readonly dirty: () => boolean | Promise<boolean>;
  /** Saves automatically; resolves with how long the guest was paused. */
  readonly save: () => Promise<{ readonly pauseMilliseconds: number }>;
  /** Removes what no restore point needs any more. */
  readonly collect: () => Promise<void>;
  readonly emit: (event: AutoSaveEvent) => void;
}

/** A timer automatic saves keep: when it fires and how to cancel it. */
interface Timer {
  readonly at: number;
  readonly cancel: () => void;
}

/** A save asked for while one ran: none, one more once spacing allows, or one at once. */
type SaveRequest = "none" | "soon" | "hidden";

/**
 * Automatic saves (ADR 0014). The interval timer saves every two minutes while the guest runs;
 * the soon timer saves ten seconds after a burst of activity or file changes. Neither starts a
 * save within two seconds of a keystroke, and saves they start are at least twenty seconds and
 * twenty save durations apart. A hidden page saves at once: the user may be closing it. Saves run
 * one at a time, a request during a save becoming one more save after it, at once when the page
 * was hidden meanwhile. Saves that pause the guest longer than 250 ms at p95 double
 * the interval up to fifteen minutes. Only the browser refusing a write decides that space ran
 * out, never its own figure for free space: Brave reports 2 GiB whatever it allows. A save refused
 * for space collects what no restore point needs and runs once more; a second refusal pauses
 * automatic saves, which retry after one minute, doubling up to thirty.
 */
export class AutoSave {
  readonly #host: AutoSaveHost;
  #enabled = false;
  #interval = INTERVAL_MILLISECONDS;
  #intervalTimer: Timer | undefined;
  #soonTimer: Timer | undefined;
  #lastSaveEnd: number | undefined;
  #lastSaveDuration = 0;
  readonly #pauses: number[] = [];
  #lastKeystroke: number | undefined;
  #saving = false;
  #request: SaveRequest = "none";
  #quotaRetry = QUOTA_RETRY_MILLISECONDS;
  #preparation: AbortController | undefined;
  #prepareTimer: Timer | undefined;
  #prepared = false;

  constructor(host: AutoSaveHost) {
    this.#host = host;
  }

  configure(policy: AutoSavePolicy): void {
    this.#enabled = policy.enabled;
    this.#stopInterval();
    this.#stopSoon();
    if (!policy.enabled) { this.#prepareTimer?.cancel(); this.#prepareTimer = undefined; this.#preparation?.abort(); this.#prepared = false; }
    else this.#armPreparation(this.#host.now());
    if (policy.enabled) this.#armInterval(this.#host.now() + this.#interval);
  }

  hint(hint: AutoSaveHint): void {
    if (!this.#enabled) return;
    const now = this.#host.now();
    switch (hint) {
      case "hidden":
        // The user left the page and may close it: save now, or right after a running save, not
        // after spacing or typing.
        void this.#fire("hidden");
        return;
      case "activity":
        this.#lastKeystroke = now;
        this.#preparation?.abort();
        this.#armPreparation(now + TYPING_GUARD_MILLISECONDS);
        this.#requestSoon(now + ACTIVITY_DEBOUNCE_MILLISECONDS, true);
        return;
      case "files-changed":
        this.#requestSoon(now + ACTIVITY_DEBOUNCE_MILLISECONDS, true);
        return;
      case "visible":
        return;
    }
  }

  resetPreparation(): void {
    this.#prepared = false; this.#preparation?.abort();
    if (this.#enabled) this.#armPreparation(this.#host.now());
  }

  #armPreparation(at: number): void {
    if (this.#host.prepare === undefined || this.#prepared || !this.#enabled) return;
    this.#prepareTimer?.cancel();
    this.#prepareTimer = this.#timer(at, () => { this.#prepareTimer = undefined; void this.#prepare(); });
  }

  async #prepare(): Promise<void> {
    if (!this.#enabled || this.#prepared || this.#host.prepare === undefined) return;
    const quiet = (this.#lastKeystroke ?? -Infinity) + TYPING_GUARD_MILLISECONDS;
    if (this.#saving || this.#preparation !== undefined || this.#host.now() < quiet) {
      this.#armPreparation(Math.max(this.#host.now() + TYPING_GUARD_MILLISECONDS, quiet)); return;
    }
    const controller = new AbortController(); this.#preparation = controller;
    let retry: number | undefined;
    try {
      retry = await this.#saveOrPause(() => this.#host.prepare?.(controller.signal) ?? Promise.resolve());
      if (!controller.signal.aborted && retry === undefined) this.#prepared = true;
    } catch { retry = this.#interval; }
    finally { if (this.#preparation === controller) this.#preparation = undefined; }
    if (this.#preparationEnabled()) this.#armPreparation(controller.signal.aborted
      ? Math.max(this.#host.now(), (this.#lastKeystroke ?? -Infinity) + TYPING_GUARD_MILLISECONDS)
      : this.#host.now() + (retry ?? this.#interval));
  }

  #preparationEnabled(): boolean { return this.#enabled && !this.#prepared; }

  /** A save made for another reason (a named or safety point) counts as the latest save. */
  saved(endedAt: number, durationMilliseconds: number, pauseMilliseconds: number): void {
    this.#record(endedAt, durationMilliseconds, pauseMilliseconds);
    if (this.#enabled && !this.#saving) this.#armInterval(endedAt + this.#interval);
  }

  /**
   * Asks for a save at `at`, or as soon after as spacing allows. A debounced request moves the
   * soon timer later; an immediate one keeps an earlier one.
   */
  #requestSoon(at: number, debounced: boolean): void {
    if (this.#saving) {
      this.#askAfterSave("soon");
      return;
    }
    const due = Math.max(at, this.#spacedFrom());
    if (!debounced && this.#soonTimer !== undefined && this.#soonTimer.at <= due) return;
    this.#stopSoon();
    this.#soonTimer = this.#timer(due, () => {
      this.#soonTimer = undefined;
      void this.#fire("soon");
    });
  }

  #armInterval(at: number): void {
    this.#stopInterval();
    this.#intervalTimer = this.#timer(at, () => {
      this.#intervalTimer = undefined;
      void this.#fire("interval");
    });
  }

  #timer(at: number, run: () => void): Timer {
    return { at, cancel: this.#host.schedule(Math.max(0, at - this.#host.now()), run) };
  }

  #stopInterval(): void {
    this.#intervalTimer?.cancel();
    this.#intervalTimer = undefined;
  }

  #stopSoon(): void {
    this.#soonTimer?.cancel();
    this.#soonTimer = undefined;
  }

  /** Asks for one more save after the running one; a hidden page's request wins. */
  #askAfterSave(request: "soon" | "hidden"): void {
    if (this.#request !== "hidden") this.#request = request;
  }

  /** The save asked for while one ran; taking it clears the request. */
  #takeRequest(): SaveRequest {
    const request = this.#request;
    this.#request = "none";
    return request;
  }

  #spacedFrom(): number {
    if (this.#lastSaveEnd === undefined) return 0;
    return this.#lastSaveEnd + Math.max(MIN_SPACING_MILLISECONDS, SPACING_FACTOR * this.#lastSaveDuration);
  }

  async #fire(timer: "interval" | "soon" | "hidden"): Promise<void> {
    if (!this.#enabled) return;
    const now = this.#host.now();
    const quietFrom = (this.#lastKeystroke ?? -Infinity) + TYPING_GUARD_MILLISECONDS;
    if (timer !== "hidden" && now < quietFrom) {
      // The user typed a moment ago: try again once they have paused.
      if (timer === "interval") this.#armInterval(quietFrom);
      else this.#requestSoon(quietFrom, true);
      return;
    }
    if (this.#saving) {
      this.#askAfterSave(timer === "hidden" ? "hidden" : "soon");
      return;
    }
    await this.#save();
  }

  /**
   * Saves, collecting and saving once more when the browser refuses the save for lack of space.
   * The save is in flight until then, so a timer that fires meanwhile becomes one more save after
   * it.
   */
  async #save(): Promise<void> {
    this.#saving = true;
    this.#request = "none";
    this.#stopSoon();
    this.#stopInterval();
    let retry: number | undefined;
    try {
      if (await this.#host.dirty() && this.#enabled) retry = await this.#saveOrPause();
    } catch {
      // The snapshot session reports the failure; the next interval tries again.
    } finally {
      this.#saving = false;
    }
    const request = this.#takeRequest();
    if (!this.#enabled) return;
    const now = this.#host.now();
    if (retry !== undefined) {
      // No room: what was asked for meanwhile waits for the retry too.
      this.#armInterval(now + retry);
      return;
    }
    this.#armInterval(now + this.#interval);
    if (request === "hidden") void this.#fire("hidden");
    else if (request === "soon") this.#requestSoon(now, false);
  }

  /**
   * Undefined once a save succeeds; when the browser refuses it twice for lack of space, with a
   * collection in between, reports the pause and returns when to try again. Other failures throw.
   */
  async #saveOrPause(run: () => Promise<void> = () => this.#saveOnce()): Promise<number | undefined> {
    try {
      await run();
    } catch (error) {
      if (!refusedForSpace(error)) throw error;
      await this.#host.collect();
      try {
        await run();
      } catch (again) {
        if (!refusedForSpace(again)) throw again;
        const retry = this.#quotaRetry;
        this.#quotaRetry = Math.min(retry * 2, MAX_QUOTA_RETRY_MILLISECONDS);
        this.#host.emit({ type: "auto-save-paused", reason: "quota", retryInMilliseconds: retry });
        return retry;
      }
    }
    this.#quotaRetry = QUOTA_RETRY_MILLISECONDS;
    return undefined;
  }

  async #saveOnce(): Promise<void> {
    const startedAt = this.#host.now();
    const { pauseMilliseconds } = await this.#host.save();
    const endedAt = this.#host.now();
    this.#record(endedAt, endedAt - startedAt, pauseMilliseconds);
  }

  #record(endedAt: number, durationMilliseconds: number, pauseMilliseconds: number): void {
    this.#lastSaveEnd = endedAt;
    this.#lastSaveDuration = durationMilliseconds;
    this.#pauses.push(pauseMilliseconds);
    if (this.#pauses.length > PAUSE_WINDOW) this.#pauses.shift();
    // With at most five samples, the p95 is the largest.
    const p95 = Math.max(...this.#pauses);
    this.#interval = p95 > PAUSE_BUDGET_MILLISECONDS
      ? Math.min(this.#interval * 2, MAX_INTERVAL_MILLISECONDS)
      : INTERVAL_MILLISECONDS;
  }
}

/** Whether a save failed because the browser refused to store more. */
function refusedForSpace(error: unknown): boolean {
  return error instanceof VMError && error.code === "QUOTA_EXCEEDED";
}
