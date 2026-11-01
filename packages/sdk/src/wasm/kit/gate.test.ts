import { expect, it } from "vitest";
import { createGate } from "./gate.js";

it("grants the gate to one owner at a time, in arrival order, and ignores a second release", async () => {
  const gate = createGate(), signal = new AbortController().signal, order: string[] = [];
  const first = await gate.acquire(signal);
  const second = gate.acquire(signal).then(release => { order.push("second"); return release; });
  const third = gate.acquire(signal).then(release => { order.push("third"); release(); });
  await Promise.resolve();
  expect(order).toEqual([]);
  first();
  const releaseSecond = await second;
  expect(order).toEqual(["second"]);
  first(); // a double release must not hand the gate to the third waiter early
  await Promise.resolve();
  expect(order).toEqual(["second"]);
  releaseSecond();
  await third;
  expect(order).toEqual(["second", "third"]);
  (await gate.acquire(signal))();
});

it("removes a cancelled waiter so it never receives the gate", async () => {
  const gate = createGate(), signal = new AbortController().signal, cancel = new AbortController();
  const first = await gate.acquire(signal);
  const cancelled = gate.acquire(cancel.signal);
  const next = gate.acquire(signal);
  cancel.abort(new Error("Disconnected before the query ran"));
  await expect(cancelled).rejects.toThrow(/Disconnected/u);
  first();
  const release = await next;
  release();
  (await gate.acquire(signal))();
});

it("rejects an already aborted signal without taking the gate", async () => {
  const gate = createGate(), aborted = AbortSignal.abort(new Error("late"));
  await expect(gate.acquire(aborted)).rejects.toThrow("late");
  (await gate.acquire(new AbortController().signal))();
});

it("turns a reason that is not an error into an ABORTED error", async () => {
  const gate = createGate(), owner = new AbortController(), waiter = new AbortController();
  const held = await gate.acquire(owner.signal);
  const waiting = gate.acquire(waiter.signal);
  waiter.abort("plain text");
  await expect(waiting).rejects.toMatchObject({ code: "ABORTED" });
  await expect(gate.acquire(AbortSignal.abort("again"))).rejects.toMatchObject({ code: "ABORTED" });
  held();
});
