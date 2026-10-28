import { describe, expect, it, vi } from "vitest";

import {
  createMailbox, publishRequest, takeRequest, completeReply, waitForReply, closeMailbox,
} from "./mailbox.ts";

describe("assistance synchronous mailbox", () => {
  it("waits without an application deadline and wakes when its broker closes", () => {
    const box = createMailbox();
    publishRequest(box, 1, new Uint8Array());
    const wait = vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
      expect(timeout).toBeUndefined();
      closeMailbox(box);
      return "ok";
    });
    try {
      expect(() => waitForReply(box, 1, null)).toThrow("mailbox closed");
      expect(wait).toHaveBeenCalledOnce();
    } finally {
      wait.mockRestore();
    }
  });

  it("copies a request before a producer can mutate its published bytes", () => {
    const box = createMailbox();
    publishRequest(box, 1, Uint8Array.of(7, 8));
    const request = takeRequest(box, 1);
    new Uint8Array(box).fill(255, 16);
    expect([...request]).toEqual([7, 8]);
    expect(completeReply(box, 1, Uint8Array.of(9))).toBe(true);
    expect([...waitForReply(box, 1, 0)]).toEqual([9]);
  });

  it("does not resurrect a cancelled mailbox with a late reply", () => {
    const box = createMailbox();
    publishRequest(box, 1, new Uint8Array());
    takeRequest(box, 1);
    closeMailbox(box);
    expect(completeReply(box, 1, Uint8Array.of(1))).toBe(false);
    expect(() => waitForReply(box, 1, 0)).toThrow("closed");
    expect(() => publishRequest(box, 2, new Uint8Array())).toThrow();
  });

  it("rejects invalid lengths and stale sequences", () => {
    const box = createMailbox();
    expect(() => publishRequest(box, 0, new Uint8Array())).toThrow();
    publishRequest(box, 1, new Uint8Array());
    expect(() => takeRequest(box, 2)).toThrow();
    Atomics.store(new Int32Array(box, 0, 4), 2, -1);
    expect(() => takeRequest(box, 1)).toThrow();
  });

  it("closes on timeout and rejects oversized input before publication", () => {
    const box = createMailbox();
    expect(() => publishRequest(box, 1, new Uint8Array(131_073))).toThrow();
    publishRequest(box, 1, new Uint8Array());
    expect(() => waitForReply(box, 1, 0)).toThrow("deadline");
    expect(completeReply(box, 1, new Uint8Array())).toBe(false);
  });

  it("carries a complete encoded envelope and the entire unsigned sequence range", () => {
    const box = createMailbox();
    const payload = new Uint8Array(131_072).fill(37);
    for (const sequence of [0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
      publishRequest(box, sequence, payload);
      const request = takeRequest(box, sequence);
      expect(request.byteLength).toBe(payload.byteLength);
      expect(request.every((byte, index) => byte === payload[index])).toBe(true);
      expect(completeReply(box, sequence, payload)).toBe(true);
      const reply = waitForReply(box, sequence, 0);
      expect(reply.byteLength).toBe(payload.byteLength);
      expect(reply.every((byte, index) => byte === payload[index])).toBe(true);
    }
    expect(() => publishRequest(box, 1, payload)).toThrow("stale");
    expect(() => publishRequest(box, 0x1_0000_0000, payload)).toThrow("sequence");
  });
});
