import { expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createNodeAbortListeners } from "./node-abort-listener.js";

it("keeps protected abort listeners in order with the original event when propagation stops", () => {
  const original = Object.getOwnPropertyDescriptor(Event.prototype, "stopImmediatePropagation"), aborts = createNodeAbortListeners();
  const controller = new AbortController(), seen: unknown[] = [];
  let dispatched: Event | undefined;
  controller.signal.addEventListener("abort", event => { dispatched = event; seen.push("first"); event.stopImmediatePropagation(); });
  aborts.addAbortListener(controller.signal, function (this: unknown, event: Event) {
    seen.push(["protected", this === controller.signal, event === dispatched, event.target === controller.signal]);
    event.stopImmediatePropagation();
  });
  controller.signal.addEventListener("abort", () => seen.push("blocked"));
  aborts.addAbortListener(controller.signal, () => seen.push("last"));
  try {
    controller.abort(); controller.abort();
    expect(seen).toEqual(["first", ["protected", true, true, true], "last"]);
  } finally { aborts.restore(); }
  expect(Object.getOwnPropertyDescriptor(Event.prototype, "stopImmediatePropagation")).toEqual(original);
});

it("disposes pending listeners and retains Node 24's already-aborted microtask semantics", async () => {
  const aborts = createNodeAbortListeners(), controller = new AbortController();
  const pending = vi.fn(), already = vi.fn();
  try {
    const subscription = aborts.addAbortListener(controller.signal, pending);
    subscription[Symbol.dispose](); subscription[Symbol.dispose](); controller.abort();
    expect(pending).not.toHaveBeenCalled();
    const expired = aborts.addAbortListener(controller.signal, already);
    expired[Symbol.dispose]();
    expect(already).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(already.mock.calls).toEqual([[]]);
    expect(Object.getPrototypeOf(expired)).toBeNull();
    for (const signal of [null, undefined, {}]) assert.throws(() => aborts.addAbortListener(signal, pending), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => aborts.addAbortListener(controller.signal, {}), { code: "ERR_INVALID_ARG_TYPE" });
  } finally { aborts.restore(); }
});

it("does not call a protected listener twice when a later listener stops propagation", () => {
  const aborts = createNodeAbortListeners(), controller = new AbortController(), listener = vi.fn();
  try {
    aborts.addAbortListener(controller.signal, listener);
    aborts.addAbortListener(controller.signal, listener);
    controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
    controller.abort();
    expect(listener).toHaveBeenCalledOnce();
  } finally { aborts.restore(); }
});
