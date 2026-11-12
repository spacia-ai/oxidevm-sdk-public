import { describe, expect, it } from "vitest";

import { serializeUnknownError, VMError } from "../../errors.js";
import type { SaveReport } from "../../protocol.js";
import { AutoSave, type AutoSaveEvent, type AutoSaveHost } from "./auto-save.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-11-11T10:00:00.000Z" };

/** How the JS process driver refuses a save while a JS process lives. */
const JS_PROCESS_ACTIVE = new VMError("FEATURE_NOT_AVAILABLE", "Snapshots and suspend cannot capture a live JS process", { reason: "js-process-active" });
/** How the engine refuses to begin a checkpoint while the workspace is not quiesced. */
const NOT_QUIESCED = new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin", {
  reason: "checkpoint-begin-rejected", phase: "initial-round", domain: "runtime", owner: "workspace",
  nativeReason: 1, scalar0: 0, scalar1: 0, nativeCauses: ["not-quiesced"],
});
/** The refusal the Playground reported on 2026-11-11: a stale host dispatch hint, not a busy VM. */
const HOST_REFERENCE = new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin", {
  reason: "checkpoint-begin-rejected", phase: "owner-read", domain: "runtime", owner: "host",
  nativeReason: 2, scalar0: 0, scalar1: 0, nativeCauses: ["reference"],
});
/** A checkpoint refusal whose detail does not decode: its causes are a string, not a list. */
const GARBLED_NOT_QUIESCED = new VMError("PROTOCOL_ERROR", "Native checkpoint could not begin", {
  reason: "checkpoint-begin-rejected", phase: "initial-round", domain: "runtime", owner: "workspace",
  nativeReason: 1, scalar0: 0, scalar1: 0, nativeCauses: "not-quiesced",
});

type Pause = Extract<AutoSaveEvent, { readonly type: "auto-save-paused" }>;

function busy(cause: "js-process-active" | "not-quiesced", retryInMilliseconds: number): Pause {
  return { type: "auto-save-paused", reason: "busy", cause, retryInMilliseconds };
}

function quota(retryInMilliseconds: number): Pause {
  return { type: "auto-save-paused", reason: "quota", retryInMilliseconds };
}

/** How long each save waited after the one before it, the first after the start. */
function gaps(saves: readonly number[]): number[] {
  return saves.map((at, index) => at - (saves[index - 1] ?? 0));
}

/** A fake clock and timer queue that runs due timers as time advances. */
class FakeClock {
  now = 0;
  readonly #timers: { at: number; run: () => void; cancelled: boolean }[] = [];

  schedule(delay: number, run: () => void): () => void {
    const timer = { at: this.now + delay, run, cancelled: false };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Advances to `this.now + by`, running each due timer at its time, and lets saves settle. */
  async advance(by: number): Promise<void> {
    const end = this.now + by;
    for (;;) {
      await settle();
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= end)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.now = due.at;
      due.run();
    }
    // A save's own duration may have moved the clock past `end`.
    this.now = Math.max(this.now, end);
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

interface Script {
  dirty: boolean;
  pauseMilliseconds: number;
  durationMilliseconds: number;
  /** While true, the browser refuses every save for lack of space. */
  full: boolean;
  /** Whether a collection frees enough space for the next save. */
  collectionFrees: boolean;
  /** A save fails with this instead, when set. */
  failure: VMError | undefined;
}

function harness(overrides: Partial<Script> = {}) {
  const clock = new FakeClock();
  const script: Script = {
    dirty: true, pauseMilliseconds: 100, durationMilliseconds: 500, full: false, collectionFrees: false, failure: undefined, ...overrides,
  };
  const saves: number[] = [];
  /** The pauses automatic saves reported. */
  const events: Pause[] = [];
  /** What the pages heard of the saves themselves. */
  const reports: SaveReport[] = [];
  let collections = 0;
  let refusals = 0;
  let release: (() => void) | undefined;
  let holding = false;
  const collectionWaiters: (() => void)[] = [];
  let holdingCollection = false;
  const host: AutoSaveHost = {
    now: () => clock.now,
    schedule: (delay, run) => clock.schedule(delay, run),
    dirty: () => script.dirty,
    // Reports as the control worker's saves do: the start, then how the save ended.
    save: async (report) => {
      saves.push(clock.now);
      report({ type: "save-started", kind: "automatic" });
      try {
        if (holding) await new Promise<void>((resolve) => { release = resolve; });
        if (script.failure !== undefined) throw script.failure;
        if (script.full) {
          refusals += 1;
          throw new VMError("QUOTA_EXCEEDED", "storage is full", { phase: "write-out" });
        }
        clock.now += script.durationMilliseconds;
        const { pauseMilliseconds, durationMilliseconds } = script;
        report({ type: "save-finished", kind: "automatic", snapshot: SNAPSHOT, pauseMilliseconds, durationMilliseconds });
        return { pauseMilliseconds };
      } catch (error) {
        report({ type: "save-failed", kind: "automatic", error: serializeUnknownError(error) });
        throw error;
      }
    },
    collect: async () => {
      collections += 1;
      if (holdingCollection) await new Promise<void>((resolve) => { collectionWaiters.push(resolve); });
      if (script.collectionFrees) script.full = false;
    },
    emit: (event) => {
      if (event.type === "auto-save-paused") events.push(event);
      else reports.push(event);
    },
  };
  const autoSave = new AutoSave(host);
  autoSave.configure({ enabled: true });
  return {
    clock,
    script,
    saves,
    events,
    reports,
    autoSave,
    collections: () => collections,
    refusals: () => refusals,
    hold: () => { holding = true; },
    release: () => { holding = false; release?.(); },
    /** Keeps collections waiting until `releaseCollection`. */
    holdCollection: () => { holdingCollection = true; },
    releaseCollection: () => {
      holdingCollection = false;
      for (const resolve of collectionWaiters.splice(0)) resolve();
    },
  };
}

describe("automatic saves", () => {
  it("prepares dependencies after enable, yields to typing, and never records preparation as a save", async () => {
    const clock=new FakeClock(),starts:number[]=[],signals:AbortSignal[]=[],events:AutoSaveEvent[]=[];
    const host:AutoSaveHost={now:()=>clock.now,schedule:(delay,run)=>clock.schedule(delay,run),dirty:()=>false,save:()=>Promise.resolve({pauseMilliseconds:0}),collect:()=>Promise.resolve(),emit:event=>events.push(event),
      prepare:signal=>{starts.push(clock.now);signals.push(signal);return new Promise<void>((resolve)=>signal.addEventListener("abort",()=>resolve(),{once:true}));}};
    const automatic=new AutoSave(host);automatic.configure({enabled:true});await clock.advance(0);
    expect(starts).toHaveLength(1);automatic.hint("activity");expect(signals[0]?.aborted).toBe(true);
    await clock.advance(1999);expect(starts).toHaveLength(1);await clock.advance(1);expect(starts).toHaveLength(2);
    expect(events).toEqual([]);automatic.configure({enabled:false});expect(signals[1]?.aborted).toBe(true);
  });
  it("waits for the execution worker's dirty result and serializes hints during that read", async () => {
    const clock = new FakeClock();
    const pending = Promise.withResolvers<boolean>();
    let polls = 0, saves = 0;
    const autoSave = new AutoSave({
      now: () => clock.now, schedule: (delay, run) => clock.schedule(delay, run),
      dirty: () => { polls++; return polls === 1 ? pending.promise : Promise.resolve(false); },
      save: () => { saves++; return Promise.resolve({ pauseMilliseconds: 1 }); },
      collect: () => Promise.resolve(), emit: () => {},
    });
    autoSave.configure({ enabled: true });
    autoSave.hint("hidden"); await settle();
    autoSave.hint("hidden"); await settle();
    expect(polls).toBe(1); expect(saves).toBe(0);
    pending.resolve(true); await settle();
    expect(saves).toBe(1); expect(polls).toBe(2);
  });
  it("saves every two minutes while the guest changes, and not while it does not", async () => {
    const { clock, script, saves } = harness();

    await clock.advance(2 * MINUTE);
    expect(saves).toEqual([2 * MINUTE]);
    script.dirty = false;
    await clock.advance(4 * MINUTE);
    expect(saves).toHaveLength(1);
  });

  it("saves again once the guest changes after a quiet spell", async () => {
    const { clock, script, saves } = harness({ dirty: false });

    await clock.advance(2 * MINUTE);
    script.dirty = true;
    await clock.advance(2 * MINUTE);

    expect(saves).toEqual([4 * MINUTE]);
  });

  it("keeps saving every two minutes while files keep changing", async () => {
    const { clock, saves, autoSave } = harness();

    for (let at = 5; at <= 250; at += 5) {
      await clock.advance(at * SECOND - clock.now);
      autoSave.hint("files-changed");
    }

    expect(saves).toEqual([2 * MINUTE, 4 * MINUTE + 500]);
  });

  it("counts a named save as the latest save", async () => {
    const { clock, saves, autoSave } = harness();

    await clock.advance(MINUTE);
    autoSave.saved(MINUTE, 500, 100);
    await clock.advance(MINUTE + 30 * SECOND);
    expect(saves).toEqual([]);
    await clock.advance(30 * SECOND);
    expect(saves).toEqual([3 * MINUTE]);
  });

  it("saves ten seconds after activity, but never within two seconds of typing", async () => {
    const { clock, saves, autoSave } = harness();

    await clock.advance(30 * SECOND);
    autoSave.hint("activity");
    await clock.advance(9 * SECOND);
    autoSave.hint("activity");
    await clock.advance(9 * SECOND);
    expect(saves).toEqual([]);
    await clock.advance(1 * SECOND);
    expect(saves).toEqual([49 * SECOND]);
  });

  it("keeps saving every two minutes while the user types in bursts", async () => {
    const { clock, saves, autoSave } = harness();

    for (let at = 100; at <= 200; at += 5) {
      await clock.advance(at * SECOND - clock.now);
      autoSave.hint("activity");
    }

    expect(saves[0]).toBe(120 * SECOND);
  });

  it("never starts a save within two seconds of a keystroke", async () => {
    const { clock, saves, autoSave } = harness();

    for (let at = 100; at <= 125; at += 1) {
      await clock.advance(at * SECOND - clock.now);
      autoSave.hint("activity");
    }
    await clock.advance(140 * SECOND - clock.now);

    // Due at 120 s, the save waited for a two-second pause after the last keystroke at 125 s.
    expect(saves).toEqual([127 * SECOND]);
  });

  it("saves at once when the page is hidden", async () => {
    const { clock, saves, autoSave } = harness();

    await clock.advance(30 * SECOND);
    autoSave.hint("hidden");
    await clock.advance(0);

    expect(saves).toEqual([30 * SECOND]);
  });

  it("runs one save at a time and folds triggers that arrive meanwhile into one more", async () => {
    const { clock, saves, autoSave, hold, release } = harness();
    await clock.advance(30 * SECOND);
    hold();
    autoSave.hint("hidden");
    await clock.advance(0);

    autoSave.hint("hidden");
    autoSave.hint("files-changed");
    autoSave.hint("hidden");
    release();
    await clock.advance(30 * SECOND);

    expect(saves).toHaveLength(2);
  });

  it("starts one save at a time, even while a refused save collects before trying again", async () => {
    const { clock, saves, autoSave, holdCollection, releaseCollection } = harness({ full: true, collectionFrees: true });
    holdCollection();
    await clock.advance(2 * MINUTE);

    autoSave.hint("hidden");
    await clock.advance(0);
    // The hidden page's save waits for the refused one, which is still collecting.
    expect(saves).toEqual([2 * MINUTE]);
    releaseCollection();
    await clock.advance(0);

    // The refused save ran again after the collection; the hint became one more save after it.
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE, 2 * MINUTE + 500]);
  });

  it("never starts a second save while a long one runs", async () => {
    const { clock, saves, autoSave, hold, release } = harness();
    hold();
    await clock.advance(2 * MINUTE);

    // Turned on again during the save, the interval comes due before the save ends.
    autoSave.configure({ enabled: true });
    await clock.advance(3 * MINUTE);
    expect(saves).toEqual([2 * MINUTE]);
    release();
    await clock.advance(0);

    expect(saves).toEqual([2 * MINUTE]);
  });

  it("keeps saves at least twenty seconds and twenty times the last save's duration apart", async () => {
    const { clock, saves, autoSave } = harness({ durationMilliseconds: 2 * SECOND });
    autoSave.hint("files-changed");
    await clock.advance(10 * SECOND);
    // The save started at 10 s and took 2 s; the next waits until 12 s + 40 s.
    expect(saves).toEqual([10 * SECOND]);

    autoSave.hint("files-changed");
    await clock.advance(39 * SECOND);
    expect(saves).toHaveLength(1);
    await clock.advance(2 * SECOND);
    expect(saves).toEqual([10 * SECOND, 52 * SECOND]);
  });

  it("saves at once when the page is hidden, however recently it saved or the user typed", async () => {
    const { clock, saves, autoSave } = harness({ durationMilliseconds: 2 * SECOND });
    autoSave.hint("files-changed");
    await clock.advance(10 * SECOND);
    expect(saves).toEqual([10 * SECOND]);

    autoSave.hint("activity");
    autoSave.hint("hidden");
    await clock.advance(0);

    expect(saves).toEqual([10 * SECOND, 12 * SECOND]);
  });

  it("saves again right after a running save when the page is hidden meanwhile", async () => {
    const { clock, saves, autoSave, hold, release } = harness({ durationMilliseconds: 2 * SECOND });
    hold();
    autoSave.hint("hidden");
    await clock.advance(0);
    expect(saves).toEqual([0]);

    autoSave.hint("hidden");
    release();
    await clock.advance(0);

    expect(saves).toEqual([0, 2 * SECOND]);
  });

  it("keeps a hidden page's save immediate when files change during the running save", async () => {
    const { clock, saves, autoSave, hold, release } = harness({ durationMilliseconds: 2 * SECOND });
    hold();
    autoSave.hint("hidden");
    await clock.advance(0);

    autoSave.hint("hidden");
    autoSave.hint("files-changed");
    release();
    await clock.advance(0);

    expect(saves).toEqual([0, 2 * SECOND]);
  });

  it("does not save a hidden page that has not changed since its last save", async () => {
    const { clock, saves, autoSave, script } = harness();
    script.dirty = false;

    autoSave.hint("hidden");
    await clock.advance(SECOND);

    expect(saves).toEqual([]);
  });

  it("saves less often while saves pause the guest longer than 250 ms, up to every 15 minutes", async () => {
    const { clock, saves } = harness({ pauseMilliseconds: 400 });

    await clock.advance(2 * MINUTE);
    await clock.advance(4 * MINUTE);
    await clock.advance(8 * MINUTE);
    expect(saves).toHaveLength(3);
    for (let round = 0; round < 6; round += 1) await clock.advance(15 * MINUTE);
    const gaps = saves.slice(1).map((at, index) => at - (saves[index] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15 * MINUTE + 10 * SECOND);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(15 * MINUTE);
  });

  it("saves without asking the browser how much space is free", async () => {
    // Brave reports 2 GiB whatever it allows, so a site past it reads no free space at all.
    const { clock, saves, events, collections } = harness();

    await clock.advance(2 * MINUTE);

    expect(saves).toEqual([2 * MINUTE]);
    expect(collections()).toBe(0);
    expect(events).toEqual([]);
  });

  it("collects and saves again when the browser refuses a save for lack of space", async () => {
    const { clock, saves, events, collections, refusals } = harness({ full: true, collectionFrees: true });

    await clock.advance(2 * MINUTE);

    expect(refusals()).toBe(1);
    expect(collections()).toBe(1);
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE]);
    expect(events).toEqual([]);
  });

  it("pauses after a second refusal, tries again later, and starts the retry over once a save succeeds", async () => {
    const { clock, saves, events, collections, script } = harness({ full: true });

    await clock.advance(2 * MINUTE);
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE]);
    expect(collections()).toBe(1);
    expect(events).toEqual([{ type: "auto-save-paused", reason: "quota", retryInMilliseconds: MINUTE }]);

    await clock.advance(MINUTE);
    expect(saves).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "auto-save-paused", reason: "quota", retryInMilliseconds: 2 * MINUTE });

    script.full = false;
    await clock.advance(2 * MINUTE);
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE, 3 * MINUTE, 3 * MINUTE, 5 * MINUTE]);

    script.full = true;
    await clock.advance(2 * MINUTE + 500);
    expect(events.at(-1)).toEqual({ type: "auto-save-paused", reason: "quota", retryInMilliseconds: MINUTE });
  });

  it("neither collects nor pauses when a save fails for another reason", async () => {
    const failure = new VMError("STORAGE_ERROR", "snapshot storage did not answer seal-capture in time", { reason: "storage-timeout" });
    const { clock, saves, events, reports, collections } = harness({ failure });

    await clock.advance(6 * MINUTE);

    // The failed save at 2 min doubles the wait before the next one.
    expect(saves).toEqual([2 * MINUTE, 6 * MINUTE]);
    expect(collections()).toBe(0);
    expect(events).toEqual([]);
    expect(reports.filter((report) => report.type === "save-failed")).toHaveLength(2);
  });

  it("pauses automatic saves once on a busy refusal and backs off", async () => {
    const { clock, saves, events, reports } = harness({ failure: JS_PROCESS_ACTIVE });

    await clock.advance(2 * MINUTE);
    await clock.advance(MINUTE);
    await clock.advance(2 * MINUTE);

    // Refused at 2 min, saves try again 60 s later and then 120 s after that.
    expect(saves).toEqual([2 * MINUTE, 3 * MINUTE, 5 * MINUTE]);
    expect(events).toEqual([busy("js-process-active", MINUTE)]);
    expect(reports.filter((report) => report.type === "save-failed")).toEqual([]);
    // The pause ends the first try's start; the tries after it report nothing while the VM stays busy.
    expect(reports).toEqual([{ type: "save-started", kind: "automatic" }]);
    await clock.advance(4 * MINUTE - 1);
    expect(saves).toHaveLength(3);
    await clock.advance(1);
    expect(saves).toEqual([2 * MINUTE, 3 * MINUTE, 5 * MINUTE, 9 * MINUTE]);
    expect(events).toHaveLength(1);
  });

  it("pauses for a checkpoint that is not quiesced, retrying at most every fifteen minutes", async () => {
    const { clock, saves, events, reports } = harness({ failure: NOT_QUIESCED });

    for (const minutes of [2, 1, 2, 4, 8, 15, 15]) await clock.advance(minutes * MINUTE);

    expect(gaps(saves)).toEqual([2, 1, 2, 4, 8, 15, 15].map((minutes) => minutes * MINUTE));
    expect(events).toEqual([busy("not-quiesced", MINUTE)]);
    expect(reports.filter((report) => report.type === "save-failed")).toEqual([]);
    expect(reports).toEqual([{ type: "save-started", kind: "automatic" }]);
  });

  it("keeps the timed busy retry when a hint's save is refused as busy", async () => {
    const { clock, saves, events, autoSave } = harness({ failure: JS_PROCESS_ACTIVE });
    await clock.advance(2 * MINUTE);

    // Files change and the page is hidden during the pause; the VM refuses both of their saves.
    autoSave.hint("files-changed");
    await clock.advance(15 * SECOND);
    autoSave.hint("hidden");
    await clock.advance(45 * SECOND);
    // The timed retry still comes 60 s after the refusal at 2 min, and the next one 120 s later.
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE + 10 * SECOND, 2 * MINUTE + 15 * SECOND, 3 * MINUTE]);
    await clock.advance(2 * MINUTE - 1);
    expect(saves).toHaveLength(4);
    await clock.advance(1);
    expect(saves.at(-1)).toBe(5 * MINUTE);
    expect(events).toEqual([busy("js-process-active", MINUTE)]);
  });

  it("pauses until the timed save, in whole milliseconds, when a hint's save is the first refused as busy", async () => {
    const { clock, saves, events, autoSave } = harness({ failure: JS_PROCESS_ACTIVE });
    // The control worker's clock has fractions of a millisecond.
    await clock.advance(30 * SECOND + 0.5);
    autoSave.hint("files-changed");
    await clock.advance(10 * SECOND);

    // The timed save stays at 2 min, 79.5 s away, and the pause reports it rounded up.
    expect(events).toEqual([busy("js-process-active", 80 * SECOND)]);
    await clock.advance(80 * SECOND - 0.5);
    expect(saves).toEqual([40 * SECOND + 0.5, 2 * MINUTE]);
    // That refusal of the timed save starts the doubling: the next comes 60 s later.
    await clock.advance(MINUTE);
    expect(saves.at(-1)).toBe(3 * MINUTE);
  });

  it("counts a checkpoint refusal whose detail does not decode as an ordinary failure", async () => {
    const { clock, saves, events, reports } = harness({ failure: GARBLED_NOT_QUIESCED });

    await clock.advance(6 * MINUTE);

    expect(saves).toEqual([2 * MINUTE, 6 * MINUTE]);
    expect(events).toEqual([]);
    expect(reports.filter((report) => report.type === "save-failed")).toHaveLength(2);
  });

  it("reports a save that succeeds after a busy pause, and starts the busy retry over", async () => {
    const { clock, saves, script, events, reports } = harness({ failure: JS_PROCESS_ACTIVE });
    await clock.advance(2 * MINUTE);

    script.failure = undefined;
    await clock.advance(MINUTE);
    // The retry reports its start once it has got past the refusal.
    expect(reports).toEqual([
      { type: "save-started", kind: "automatic" },
      { type: "save-started", kind: "automatic" },
      { type: "save-finished", kind: "automatic", snapshot: SNAPSHOT, pauseMilliseconds: 100, durationMilliseconds: 500 },
    ]);

    script.failure = JS_PROCESS_ACTIVE;
    await clock.advance(2 * MINUTE + 500);
    expect(saves).toEqual([2 * MINUTE, 3 * MINUTE, 5 * MINUTE + 500]);
    expect(events).toEqual([busy("js-process-active", MINUTE), busy("js-process-active", MINUTE)]);
    expect(reports.at(-1)).toEqual({ type: "save-started", kind: "automatic" });
  });

  it("reports a busy pause again once its cause changes or a save ends otherwise", async () => {
    const { clock, script, events, reports } = harness({ failure: JS_PROCESS_ACTIVE });
    await clock.advance(2 * MINUTE);

    script.failure = NOT_QUIESCED;
    await clock.advance(MINUTE);
    expect(events).toEqual([busy("js-process-active", MINUTE), busy("not-quiesced", 2 * MINUTE)]);

    script.failure = HOST_REFERENCE;
    await clock.advance(2 * MINUTE);
    // A try that fails otherwise reports its start with its failure.
    expect(reports.slice(1)).toMatchObject([
      { type: "save-started", kind: "automatic" },
      { type: "save-failed", kind: "automatic", error: { code: "PROTOCOL_ERROR", detail: { owner: "host" } } },
    ]);

    // Only a success starts the busy retry over: the failure at 5 min waits four minutes.
    script.failure = JS_PROCESS_ACTIVE;
    await clock.advance(4 * MINUTE);
    expect(events.at(-1)).toEqual(busy("js-process-active", 4 * MINUTE));
    expect(reports.at(-1)).toEqual({ type: "save-started", kind: "automatic" });
  });

  it("backs off automatic saves after repeated failures and resets after a success", async () => {
    const { clock, saves, script, events, reports } = harness({ failure: HOST_REFERENCE });

    for (const minutes of [2, 4, 8, 15]) await clock.advance(minutes * MINUTE);
    script.failure = undefined;
    await clock.advance(15 * MINUTE);
    await clock.advance(2 * MINUTE);

    // Failures at 2, 6, 14 and 29 min; the save at 44 min succeeds in 500 ms and the next follows two
    // minutes after it ends.
    expect(gaps(saves)).toEqual([2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 15 * MINUTE, 15 * MINUTE, 2 * MINUTE + 500]);
    expect(reports.filter((report) => report.type === "save-failed")).toHaveLength(4);
    expect(events).toEqual([]);
  });

  it("pauses for space and for a busy VM in turn, reporting each pause", async () => {
    const { clock, saves, script, events } = harness({ full: true });
    await clock.advance(2 * MINUTE);
    expect(events).toEqual([quota(MINUTE)]);

    script.failure = JS_PROCESS_ACTIVE;
    await clock.advance(MINUTE);
    expect(events).toEqual([quota(MINUTE), busy("js-process-active", MINUTE)]);

    // Still full once the process ends: the quota retry carries on doubling.
    script.failure = undefined;
    await clock.advance(MINUTE);
    expect(saves).toEqual([2 * MINUTE, 2 * MINUTE, 3 * MINUTE, 4 * MINUTE, 4 * MINUTE]);
    expect(events).toEqual([quota(MINUTE), busy("js-process-active", MINUTE), quota(2 * MINUTE)]);
  });

  it("stops retrying a busy pause when automatic saves are turned off, and pauses afresh when on again", async () => {
    const { clock, saves, events, reports, autoSave } = harness({ failure: JS_PROCESS_ACTIVE });
    await clock.advance(2 * MINUTE);

    autoSave.configure({ enabled: false });
    await clock.advance(30 * MINUTE);
    expect(saves).toEqual([2 * MINUTE]);

    autoSave.configure({ enabled: true });
    await clock.advance(2 * MINUTE);
    expect(saves).toEqual([2 * MINUTE, 34 * MINUTE]);
    expect(events).toEqual([busy("js-process-active", MINUTE), busy("js-process-active", 2 * MINUTE)]);
    expect(reports).toEqual([{ type: "save-started", kind: "automatic" }, { type: "save-started", kind: "automatic" }]);
  });

  it("ends a busy pause when a named save succeeds", async () => {
    const { clock, saves, script, events, autoSave } = harness({ failure: JS_PROCESS_ACTIVE });
    await clock.advance(2 * MINUTE + 30 * SECOND);

    autoSave.saved(clock.now, 500, 100);
    await clock.advance(2 * MINUTE);
    expect(saves).toEqual([2 * MINUTE, 4 * MINUTE + 30 * SECOND]);
    expect(events).toEqual([busy("js-process-active", MINUTE), busy("js-process-active", MINUTE)]);

    script.failure = undefined;
    await clock.advance(MINUTE);
    expect(saves).toHaveLength(3);
  });

  it("does nothing until enabled, and stops when disabled", async () => {
    const { clock, saves, autoSave } = harness();
    autoSave.configure({ enabled: false });

    autoSave.hint("hidden");
    await clock.advance(10 * MINUTE);

    expect(saves).toEqual([]);
  });
});
