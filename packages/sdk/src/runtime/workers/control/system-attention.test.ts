import { expect, it, vi } from "vitest";

import { ATTENTION_MINIMUM_QUANTUM_MILLISECONDS, postCounted } from "../../host-attention.js";
import { emptySystemHostAttentionProfile } from "../../protocol/system-attention.js";
import { SystemAttention } from "./system-attention.js";
import { serveAttentionNotices } from "../attention-notices.js";

function counter(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

it("ends a slice for a page request the control worker has not received, after the guest's quantum", () => {
  const attention = new SystemAttention(), profile = emptySystemHostAttentionProfile(), control = counter();
  const watch = attention.channels.watch("control", control);
  attention.begin(0, 0);
  expect(attention.endsSlice(profile, 1, 0)).toBe(false);
  postCounted(control, () => undefined);
  expect(attention.endsSlice(profile, ATTENTION_MINIMUM_QUANTUM_MILLISECONDS / 2, 0)).toBe(false);
  expect(profile.deferrals).toBe(1);
  expect(attention.endsSlice(profile, ATTENTION_MINIMUM_QUANTUM_MILLISECONDS, 0)).toBe(true);
  expect(profile.yields).toEqual({ control: 1, assistance: 0, "agent-response": 0 });
  watch.delivered();
  attention.end(1, true);
  attention.begin(2, 0);
  expect(attention.endsSlice(profile, 5, 0)).toBe(false);
});

it("ends a slice when the guest agent answered a host request during it", () => {
  const attention = new SystemAttention(), profile = emptySystemHostAttentionProfile();
  attention.begin(0, 7);
  expect(attention.endsSlice(profile, 1, 7)).toBe(false);
  expect(attention.endsSlice(profile, 1, 8)).toBe(true);
  expect(profile.yields).toEqual({ control: 0, assistance: 0, "agent-response": 1 });
  // The next slice counts answers from its own start.
  attention.end(1, true);
  attention.begin(1.1, 8);
  expect(attention.endsSlice(profile, 1, 8)).toBe(false);
});

it("gives the guest the service gap it waited before attention ends its next slice", () => {
  const attention = new SystemAttention(), profile = emptySystemHostAttentionProfile(), control = counter();
  attention.channels.watch("control", control);
  postCounted(control, () => undefined);
  attention.begin(0, 0);
  expect(attention.endsSlice(profile, 1, 0)).toBe(true);
  attention.end(1, true);
  // The worker then spent 4 ms serving the host.
  attention.begin(5, 0);
  expect(attention.endsSlice(profile, 3.9, 0)).toBe(false);
  expect(attention.endsSlice(profile, 4, 0)).toBe(true);
});

it("opens a counted broker channel whose notices hold attention until the broker's messages arrive", async () => {
  vi.stubGlobal("crossOriginIsolated", true);
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };
  serveAttentionNotices(scope);
  const attention = new SystemAttention(() => ({
    postMessage: (message: unknown, transfer: Transferable[]) => { scope.onmessage?.(new MessageEvent("message", { data: structuredClone(message, { transfer }) })); },
    terminate: () => {}, addEventListener: () => {},
  }));
  const profile = emptySystemHostAttentionProfile();
  try {
    const broker = attention.openBrokerAttention();
    if (broker === undefined) throw new Error("Broker attention is unavailable");
    attention.begin(0, 0);
    broker.port.postMessage(null);
    await vi.waitFor(() => expect(attention.channels.pending()).toBe("assistance"));
    expect(attention.endsSlice(profile, 1, 0)).toBe(true);
    expect(profile.yields.assistance).toBe(1);
    broker.delivered();
    expect(attention.channels.pending()).toBeUndefined();
    broker.close();
    expect(attention.channels.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it("opens no broker channel without shared memory", () => {
  vi.stubGlobal("crossOriginIsolated", false);
  try { expect(new SystemAttention(() => { throw new Error("unused"); }).openBrokerAttention()).toBeUndefined(); }
  finally { vi.unstubAllGlobals(); }
});
