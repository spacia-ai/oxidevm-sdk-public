import { expect, it } from "vitest";
import { interruptView, signalBuffer, takeArrivals } from "../../js-process/signals.js";
import { TaskSignals } from "./task-signals.js";

const details = (value: bigint) => ({ code: -1, sender: 9, uid: 1000, value });

it("carries Rust's notices to the process in order with their details; a standard signal keeps none", () => {
  const signals = new TaskSignals();
  signals.deliver({ signal: 40, interrupt: false, details: details(1n) });
  signals.deliver({ signal: 2, interrupt: false, details: { code: 0, sender: 1, uid: 1000, value: 0n } });
  signals.deliver({ signal: 40, interrupt: false, details: details(2n) });
  signals.deliver({ signal: 35, interrupt: false, details: details(3n) });
  expect(takeArrivals(signalBuffer(signals.buffer))).toEqual([
    { signal: 2, details: null }, { signal: 40, details: details(1n) }, { signal: 40, details: details(2n) }, { signal: 35, details: details(3n) },
  ]);
});

it("offers interrupting signals one at a time, lowest first, while the interrupt word reads 0", () => {
  const signals = new TaskSignals(), word = interruptView(signals.buffer);
  signals.deliver({ signal: 36, interrupt: true, details: details(1n) });
  signals.deliver({ signal: 2, interrupt: true, details: details(0n) });
  expect(word[0]).toBe(36);
  expect(signals.waiting).toBe(true);
  Atomics.store(word, 0, 0); signals.offerInterrupts();
  expect(word[0]).toBe(2);
  expect(signals.waiting).toBe(false);
});

/**
 * The 0.0.10 qualification's intermittent Ctrl+C on a busy Python loop (SL-R3, "Open"): Pyodide's own reader of the
 * interrupt word, `_Py_CheckEmscriptenSignals_Helper`, is `let result = buffer[0]; buffer[0] = 0; return result`, a
 * plain load and then an unconditional plain store, run every few dozen bytecodes. An offer that lands between the two
 * succeeds (the word read 0), so it is never retried, and the store wipes it: the program never sees Ctrl+C. Nothing on
 * the writer's side can tell that from a signal Pyodide took, because both leave 0. A reader that takes the word with
 * one atomic exchange cannot lose it.
 */
it("an offer that lands between a plain read and the reader's store of 0 is lost; an atomic take never loses one", () => {
  const racing = new TaskSignals(), word = interruptView(racing.buffer);
  const seen = word[0];                                    // Pyodide's helper reads 0 ...
  racing.deliver({ signal: 2, interrupt: true, details: details(0n) });
  expect([word[0], racing.waiting]).toEqual([2, false]);  // ... the offer succeeds, so nothing retries it ...
  word[0] = 0;                                             // ... and the helper's store of 0 wipes it.
  racing.offerInterrupts();
  expect([seen, word[0], racing.waiting]).toEqual([0, 0, false]);

  for (const order of ["before", "after"] as const) {
    const signals = new TaskSignals(), atomic = interruptView(signals.buffer), taken: number[] = [];
    if (order === "after") taken.push(Atomics.exchange(atomic, 0, 0));
    signals.deliver({ signal: 2, interrupt: true, details: details(0n) });
    taken.push(Atomics.exchange(atomic, 0, 0));
    expect(taken.filter(signal => signal !== 0), order).toEqual([2]);
  }
});
