import { describe, expect, it } from "vitest";

import { decodeSnapshotEventMessage } from "../../protocol.js";
import { SnapshotEvents } from "./snapshot-events.js";

/** A page listening on a port: `next()` resolves with the next event that arrives. */
function listener() {
  const { port1, port2 } = new MessageChannel();
  const waiting: ((event: unknown) => void)[] = [];
  port2.addEventListener("message", (event: MessageEvent<unknown>) => waiting.shift()?.(decodeSnapshotEventMessage(event.data)));
  port2.start();
  return {
    port: port1,
    next: () => new Promise<unknown>((resolve) => waiting.push(resolve)),
    close: () => { port2.close(); },
  };
}

describe("restore point event broadcasting", () => {
  it("sends every event to each page that listens, as a versioned message", async () => {
    const events = new SnapshotEvents();
    const first = listener();
    const second = listener();
    events.listen(first.port);
    events.listen(second.port);

    const arrivals = Promise.all([first.next(), second.next()]);
    events.broadcast({ type: "save-started", kind: "automatic" });

    expect(await arrivals).toEqual([{ type: "save-started", kind: "automatic" }, { type: "save-started", kind: "automatic" }]);
    events.close();
    first.close();
    second.close();
  });
});
