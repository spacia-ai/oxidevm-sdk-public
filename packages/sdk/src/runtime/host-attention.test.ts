import { afterEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "./protocol/common.js";

import {
  ATTENTION_MAXIMUM_QUANTUM_MILLISECONDS,
  ATTENTION_MINIMUM_QUANTUM_MILLISECONDS,
  AttentionFairness,
  AttentionReceipts,
  attentionAttachment,
  createAttentionCounter,
  decodeAttentionAttachment,
  decodeAttentionCounter,
  isAttentionAttachment,
  HostAttention,
  postCounted,
} from "./host-attention.js";

function counter(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("host attention counters", () => {
  it("exist only where shared memory does", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    expect(createAttentionCounter()).toBeNull();
    vi.stubGlobal("crossOriginIsolated", true);
    const created = createAttentionCounter();
    expect(created?.length).toBe(1);
    expect(created?.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  it("decodes one shared Int32 slot or an explicit absence, and nothing else", () => {
    const shared = counter();
    expect(decodeAttentionCounter(shared, "control")).toBe(shared);
    expect(decodeAttentionCounter(null, "control")).toBeNull();
    const invalid = [undefined, 0, new Int32Array(1), new Int32Array(new SharedArrayBuffer(8)), new Uint32Array(new SharedArrayBuffer(4))];
    for (const value of invalid) {
      expect(() => decodeAttentionCounter(value, "control")).toThrow(/control attention counter is invalid/u);
    }
  });

  it("attaches a counter with a versioned first message and rejects stale or malformed attachments", () => {
    const shared = counter(), attachment = attentionAttachment(shared);
    expect(isAttentionAttachment(attachment)).toBe(true);
    expect(isAttentionAttachment({ id: 1, version: PROTOCOL_VERSION, type: "files" })).toBe(false);
    // A cloned attachment still names the producer's memory.
    const received = decodeAttentionAttachment(structuredClone(attachment));
    Atomics.add(received, 0, 5);
    expect(Atomics.load(shared, 0)).toBe(5);
    expect(() => decodeAttentionAttachment({ ...attachment, version: PROTOCOL_VERSION - 1 })).toThrow(/version or type is invalid/u);
    expect(() => decodeAttentionAttachment({ ...attachment, counter: null })).toThrow(/attached attention counter is invalid/u);
    expect(() => decodeAttentionAttachment({ ...attachment, id: 3 })).toThrow(/unexpected protocol field id/u);
  });

  it("names messages posted but not yet delivered", () => {
    const shared = counter(), receipts = new AttentionReceipts(shared);
    expect(receipts.pending()).toBe(false);
    postCounted(shared, () => undefined);
    postCounted(shared, () => undefined);
    expect(receipts.pending()).toBe(true);
    receipts.delivered();
    expect(receipts.pending()).toBe(true);
    receipts.delivered();
    expect(receipts.pending()).toBe(false);
  });

  it("does not count a post that threw, so a failed send leaves no stale attention", () => {
    const shared = counter(), receipts = new AttentionReceipts(shared);
    expect(() => { postCounted(shared, () => { throw new Error("clone failed"); }); }).toThrow("clone failed");
    expect(Atomics.load(shared, 0)).toBe(0);
    expect(receipts.pending()).toBe(false);
  });

  it("counts before it posts, so the receiver never sees a delivered message the producer has not counted", () => {
    const shared = counter(), receipts = new AttentionReceipts(shared);
    let seen: boolean | undefined;
    postCounted(shared, () => { seen = receipts.pending(); receipts.delivered(); });
    expect(seen).toBe(true);
    expect(receipts.pending()).toBe(false);
  });

  it("holds no attention for deliveries ahead of a count that trails them", () => {
    const shared = counter(), receipts = new AttentionReceipts(shared);
    receipts.delivered();
    expect(receipts.pending()).toBe(false);
    Atomics.add(shared, 0, 1);
    expect(receipts.pending()).toBe(false);
    Atomics.add(shared, 0, 1);
    expect(receipts.pending()).toBe(true);
  });

  it("compares counts across the Int32 wrap", () => {
    const shared = counter(), receipts = new AttentionReceipts(shared);
    // Both sides start at zero; walk the producer to the wrap, then let deliveries catch up in bulk.
    Atomics.store(shared, 0, -0x8000_0000);
    expect(receipts.pending()).toBe(false);
    Atomics.store(shared, 0, 0x7fff_ffff);
    expect(receipts.pending()).toBe(true);
  });

  it("posts uncounted without shared memory", () => {
    const post = vi.fn();
    postCounted(null, post);
    expect(post).toHaveBeenCalledOnce();
  });
});

describe("the execution worker's attention channels", () => {
  it("reports the first channel with undelivered messages and forgets closed channels", () => {
    const attention = new HostAttention<"control" | "js-process">();
    const control = counter(), process = counter();
    const controlWatch = attention.watch("control", control);
    const processWatch = attention.watch("js-process", process);
    expect(attention.pending()).toBeUndefined();
    postCounted(process, () => undefined);
    expect(attention.pending()).toBe("js-process");
    postCounted(control, () => undefined);
    expect(attention.pending()).toBe("control");
    controlWatch.delivered();
    expect(attention.pending()).toBe("js-process");
    // A process whose port closed with a request in flight no longer holds attention.
    processWatch.close();
    expect(attention.pending()).toBeUndefined();
    processWatch.delivered();
    processWatch.close();
    expect(attention.size).toBe(1);
  });
});

describe("the guest's share between attention yields", () => {
  it("lets attention end a fresh or post-idle slice after the minimum quantum", () => {
    const fairness = new AttentionFairness();
    expect(fairness.begin(100)).toBe(ATTENTION_MINIMUM_QUANTUM_MILLISECONDS);
    fairness.end(110, false);
    expect(fairness.begin(5_000)).toBe(ATTENTION_MINIMUM_QUANTUM_MILLISECONDS);
  });

  it("gives the guest at least the time the worker just spent between runnable slices", () => {
    const fairness = new AttentionFairness();
    fairness.begin(0);
    fairness.end(10, true);
    // Serving the host took 3 ms; the guest now runs at least 3 ms before attention yields.
    expect(fairness.begin(13)).toBe(3);
    fairness.end(20, true);
    expect(fairness.begin(20.05)).toBe(ATTENTION_MINIMUM_QUANTUM_MILLISECONDS);
    fairness.end(30, true);
    expect(fairness.begin(1_030)).toBe(ATTENTION_MAXIMUM_QUANTUM_MILLISECONDS);
  });

  it("keeps the guest's time at least the host's under continuous host traffic, up to one gap", () => {
    const fairness = new AttentionFairness();
    let now = 0, guest = 0, host = 0, gap = 0;
    for (let slice = 0; slice < 1_000; slice += 1) {
      const quantum = fairness.begin(now);
      // Attention is always pending: the guest runs exactly its quantum, then the worker
      // spends between 0.2 and 4 ms serving the host before the next slice.
      now += quantum; guest += quantum;
      fairness.end(now, true);
      gap = 0.2 + (slice % 20) * 0.2;
      now += gap; host += gap;
    }
    expect(guest).toBeGreaterThanOrEqual(host - gap);
  });
});
