import { deprecate, format, inspect } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { EventEmitter } from "./node-streams.js";
import { createNodeEvents } from "./node-events.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";

describe("node events builtin", () => {
  it("is the EventEmitter class with Node's listener inspection statics", () => {
    const { module: events, restore } = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }));
    onTestFinished(restore);
    expect(events).toBe(EventEmitter);
    expect(events.EventEmitter).toBe(EventEmitter);
    expect(Object.keys(events)).toContain("EventEmitterAsyncResource");
    expect(Object.keys(events)).toContain("getEventListeners");
    const emitter = new EventEmitter();
    const listener = (): void => undefined;
    emitter.on("data", listener);
    expect(events.getEventListeners(emitter, "data")).toEqual([listener]);
    const defaultLimit: unknown = Reflect.get(EventEmitter, "defaultMaxListeners");
    expect(events.getMaxListeners(emitter)).toBe(defaultLimit);
    events.setMaxListeners(1500, emitter);
    expect(events.getMaxListeners(emitter)).toBe(1500);
    const signal = new AbortController().signal;
    signal.addEventListener("abort", listener);
    // Platform event targets do not expose their listeners; Node's limit is a warning threshold only.
    expect(events.getEventListeners(signal, "abort")).toEqual([]);
    expect(() => { events.setMaxListeners(1500, signal); }).not.toThrow();
    expect(events.getMaxListeners(signal)).toBe(defaultLimit);
  });
});
