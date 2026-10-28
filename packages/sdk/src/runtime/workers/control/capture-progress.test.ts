import { expect, it } from "vitest";
import { AgentKind, AgentPayloadWriter } from "../../agent-protocol.js";
import type { AgentFrame } from "../../agent-protocol.js";
import { CaptureProgressEvents } from "./capture-progress.js";

it("accepts monotonic work only for the correlated live capture in dialect seven", () => {
  let progressed = 0; const events = new CaptureProgressEvents();
  events.open(42, () => { progressed += 1; });
  const frame = (work: bigint): AgentFrame => ({ version: 7, kind: AgentKind.captureProgress, requestId: 42, status: 0, payload: new AgentPayloadWriter().u32(42).u64(work).finish() });
  events.receive(frame(1n)); events.receive(frame(256n)); expect(progressed).toBe(2);
  expect(() => events.receive(frame(256n))).toThrow(/stale/u);
  expect(() => events.receive({ ...frame(257n), requestId: 43 })).toThrow(/identity/u);
  expect(() => events.receive({ ...frame(257n), version: 6 })).toThrow(/dialect/u);
  expect(() => events.receive(frame(9007199254740992n))).toThrow(/bound/u);
  events.retire(42); expect(() => events.receive(frame(512n))).toThrow(/retired/u);
});

it("bounds capture ownership and clears old generations", () => {
  const events = new CaptureProgressEvents(); events.open(1); events.open(2);
  expect(() => events.open(3)).toThrow(/capacity/u); expect(() => events.open(1)).toThrow();
  events.clear(); expect(() => events.open(3)).not.toThrow();
});
