import { describe, expect, it } from "vitest";
import { createNodeDiagnosticsChannel } from "./node-diagnostics-channel.js";

describe("node diagnostics_channel builtin", () => {
  it("publishes to subscribers of a named channel and reports subscriber presence", () => {
    const dc = createNodeDiagnosticsChannel();
    const seen: unknown[] = [];
    const channel = dc.channel("test:one");
    expect(channel.hasSubscribers).toBe(false);
    expect(dc.hasSubscribers("test:one")).toBe(false);
    const listener = (message: unknown, name: string | symbol): void => { seen.push([name, message]); };
    dc.subscribe("test:one", listener);
    expect(channel.hasSubscribers).toBe(true);
    channel.publish({ a: 1 });
    expect(dc.channel("test:one")).toBe(channel);
    expect(seen).toEqual([["test:one", { a: 1 }]]);
    expect(dc.unsubscribe("test:one", listener)).toBe(true);
    expect(dc.unsubscribe("test:one", listener)).toBe(false);
    channel.publish({ a: 2 });
    expect(seen).toHaveLength(1);
  });

  it("traces synchronous and asynchronous work through the five tracing channels", async () => {
    const dc = createNodeDiagnosticsChannel();
    const tracing = dc.tracingChannel("test:work");
    const events: string[] = [];
    const handler = (name: string) => (message: unknown): void => { events.push(`${name}:${JSON.stringify(message)}`); };
    tracing.subscribe({ start: handler("start"), end: handler("end"), asyncStart: handler("asyncStart"), asyncEnd: handler("asyncEnd"), error: handler("error") });
    expect(tracing.hasSubscribers).toBe(true);
    expect(tracing.traceSync((value: unknown) => Number(value) * 2, { step: 1 }, undefined, 21)).toBe(42);
    expect(() => tracing.traceSync(() => { throw new Error("boom"); }, { step: 2 })).toThrow("boom");
    await expect(tracing.tracePromise(() => Promise.resolve("ok"), { step: 3 })).resolves.toBe("ok");
    expect(events).toEqual([
      'start:{"step":1}', 'end:{"step":1,"result":42}',
      'start:{"step":2}', 'error:{"step":2,"error":{}}', 'end:{"step":2,"error":{}}',
      'start:{"step":3}', 'end:{"step":3}', 'asyncStart:{"step":3,"result":"ok"}', 'asyncEnd:{"step":3,"result":"ok"}',
    ]);
    const untraced = dc.tracingChannel("test:idle");
    expect(untraced.hasSubscribers).toBe(false);
    expect(untraced.traceSync(() => "direct")).toBe("direct");
  });
});
