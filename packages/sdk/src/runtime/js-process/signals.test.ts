import { describe, expect, it } from "vitest";
import {
  deliverArrival, interruptView, offerInterrupt, SIGNAL_BUFFER_BYTES, SIGNAL_RING_SLOTS, signalBuffer, takeArrivals, TRAPPABLE_SIGNALS, type SignalArrival,
} from "./signals.js";

const details = (value: bigint, sender = 7) => ({ code: -1, sender, uid: 1000, value });
const fresh = () => signalBuffer(new SharedArrayBuffer(SIGNAL_BUFFER_BYTES));

describe("the protocol-5 signal buffer", () => {
  it("is 1,568 bytes: 64 pending bits, Pyodide's interrupt word at byte 8 and 64 slots of 24 bytes from byte 32", () => {
    expect(SIGNAL_BUFFER_BYTES).toBe(1568);
    expect(SIGNAL_RING_SLOTS).toBe(64);
    expect(32 + SIGNAL_RING_SLOTS * 24).toBe(SIGNAL_BUFFER_BYTES);
    const buffer = fresh(), bytes = new DataView(buffer.buffer);
    // A standard signal sets its bit, n - 1, in the low word; a real-time one without details its bit in the high word.
    deliverArrival(buffer, { signal: 2, details: null });
    deliverArrival(buffer, { signal: 64, details: null });
    expect(bytes.getUint32(0, true)).toBe(1 << 1);
    expect(bytes.getUint32(4, true)).toBe(0x8000_0000);
    // A real-time arrival with details takes a slot: i32 signal, i32 si_code, u32 si_pid, u32 si_uid, u64 si_value.
    deliverArrival(buffer, { signal: 36, details: details(0x1122_3344_5566_7788n) });
    expect(bytes.getUint32(12, true)).toBe(1);
    expect([bytes.getInt32(32, true), bytes.getInt32(36, true), bytes.getUint32(40, true), bytes.getUint32(44, true), bytes.getBigUint64(48, true)]).toEqual([36, -1, 7, 1000, 0x1122_3344_5566_7788n]);
    // The interrupt word is the Int32 at byte 8, the view the runner hands to Pyodide.
    expect(offerInterrupt(buffer, 2)).toBe(true);
    expect(bytes.getInt32(8, true)).toBe(2);
    expect(interruptView(buffer.buffer)[0]).toBe(2);
    expect(interruptView(buffer.buffer).byteOffset).toBe(8);
    expect(offerInterrupt(buffer, 15)).toBe(false);
  });

  it("hands arrivals over once: standard signals lowest first, then queued real-time arrivals in order with their details, then those that lost them", () => {
    const buffer = fresh();
    deliverArrival(buffer, { signal: 36, details: details(1n) });
    deliverArrival(buffer, { signal: 15, details: null });
    deliverArrival(buffer, { signal: 35, details: details(2n) });
    deliverArrival(buffer, { signal: 36, details: details(3n) });
    deliverArrival(buffer, { signal: 2, details: null });
    deliverArrival(buffer, { signal: 2, details: null });
    expect(takeArrivals(buffer)).toEqual<SignalArrival[]>([
      { signal: 2, details: null }, { signal: 15, details: null },
      { signal: 36, details: details(1n) }, { signal: 35, details: details(2n) }, { signal: 36, details: details(3n) },
    ]);
    expect(takeArrivals(buffer)).toEqual([]);
  });

  it("falls back to the pending bit without details when the ring is full, and never corrupts it", () => {
    const buffer = fresh();
    for (let index = 0; index < SIGNAL_RING_SLOTS; index++) deliverArrival(buffer, { signal: 40, details: details(BigInt(index)) });
    deliverArrival(buffer, { signal: 41, details: details(999n) });
    const taken = takeArrivals(buffer);
    expect(taken).toHaveLength(SIGNAL_RING_SLOTS + 1);
    expect(taken.slice(0, SIGNAL_RING_SLOTS).map(arrival => arrival.details?.value)).toEqual(Array.from({ length: SIGNAL_RING_SLOTS }, (_, index) => BigInt(index)));
    expect(taken.at(-1)).toEqual({ signal: 41, details: null });
    // The ring keeps working across the wrap.
    for (let round = 0; round < 3; round++) {
      deliverArrival(buffer, { signal: 50, details: details(BigInt(round)) });
      expect(takeArrivals(buffer)).toEqual([{ signal: 50, details: details(BigInt(round)) }]);
    }
  });

  it("refuses a buffer of the wrong size or kind, an untrappable signal, and a corrupted ring", () => {
    for (const buffer of [new SharedArrayBuffer(8), new SharedArrayBuffer(SIGNAL_BUFFER_BYTES + 8), new ArrayBuffer(SIGNAL_BUFFER_BYTES), undefined]) expect(() => signalBuffer(buffer)).toThrow("Invalid JS process signal buffer");
    expect(TRAPPABLE_SIGNALS).toEqual([1, 2, 3, 10, 12, 15, ...Array.from({ length: 30 }, (_, index) => 35 + index)]);
    const buffer = fresh();
    new DataView(buffer.buffer).setUint32(0, 1 << 8, true); // SIGKILL's bit
    expect(() => takeArrivals(buffer)).toThrow("Invalid pending JS process signals");
    const ring = fresh(); new DataView(ring.buffer).setUint32(12, SIGNAL_RING_SLOTS + 1, true);
    expect(() => takeArrivals(ring)).toThrow("Invalid JS process signal ring");
    const slot = fresh(); deliverArrival(slot, { signal: 40, details: details(1n) }); new DataView(slot.buffer).setInt32(32, 9, true);
    expect(() => takeArrivals(slot)).toThrow("Invalid JS process signal ring");
  });
});
