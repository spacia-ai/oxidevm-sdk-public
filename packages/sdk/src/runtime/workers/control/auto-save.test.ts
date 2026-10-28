import { describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { AutoSave, type AutoSaveEvent, type AutoSaveHost } from "./auto-save.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

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
  const events: AutoSaveEvent[] = [];
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
    save: async () => {
      saves.push(clock.now);
      if (holding) await new Promise<void>((resolve) => { release = resolve; });
      if (script.failure !== undefined) throw script.failure;
      if (script.full) {
        refusals += 1;
        throw new VMError("QUOTA_EXCEEDED", "storage is full", { phase: "write-out" });
      }
      clock.now += script.durationMilliseconds;
      return { pauseMilliseconds: script.pauseMilliseconds };
    },
    collect: async () => {
      collections += 1;
      if (holdingCollection) await new Promise<void>((resolve) => { collectionWaiters.push(resolve); });
      if (script.collectionFrees) script.full = false;
    },
    emit: (event) => events.push(event),
  };
  const autoSave = new AutoSave(host);
  autoSave.configure({ enabled: true });
  return {
    clock,
    script,
    saves,
    events,
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
    const { clock, saves, events, collections } = harness({ failure });

    await clock.advance(4 * MINUTE);

    expect(saves).toEqual([2 * MINUTE, 4 * MINUTE]);
    expect(collections()).toBe(0);
    expect(events).toEqual([]);
  });

  it("does nothing until enabled, and stops when disabled", async () => {
    const { clock, saves, autoSave } = harness();
    autoSave.configure({ enabled: false });

    autoSave.hint("hidden");
    await clock.advance(10 * MINUTE);

    expect(saves).toEqual([]);
  });
});
