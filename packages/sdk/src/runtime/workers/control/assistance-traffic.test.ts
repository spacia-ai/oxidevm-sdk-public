import { expect, it } from "vitest";
import { AssistanceTraffic } from "./assistance-traffic.js";

it("v6 wire producers conserve the same VM budget and cannot substitute return authority", async () => {
  const traffic = new AssistanceTraffic(6);
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const network = traffic.grant({ ...binding, producer: "network", process: null, pool: "data", bytes: 1024 * 1024, entries: 2 });
  const storage = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: 14 * 1024 * 1024, entries: 2 });
  expect(() => traffic.grant({ ...binding, producer: "ipc", process: 1, pool: "data", bytes: 1, entries: 1 })).toThrow("capacity");
  await expect(Promise.resolve().then(() => traffic.grant({ ...binding, producer: "ipc", process: 1, pool: "data", bytes: 1, entries: 1 }))).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED", detail: { pool: "data", producer: "ipc", requestedBytes: 1,
      requestedEntries: 1, pendingBytes: 15 * 1024 * 1024, pendingEntries: 4 },
  });
  const stop = traffic.grant({ ...binding, producer: "installation", process: null, pool: "control", bytes: 1024 * 1024, entries: 1 });
  expect(traffic.pendingBytes).toBe(16 * 1024 * 1024);
  expect(() => traffic.returnCredit({ ...network, kind: "return", producer: "storage" })).toThrow("stale");
  for (const grant of [network, storage, stop]) traffic.returnCredit({ ...grant, kind: "return" });
  expect(() => traffic.returnCredit({ ...network, kind: "return" })).toThrow("stale");
  expect(traffic.pendingBytes).toBe(0);
  expect(traffic.pendingEntries).toBe(0);
  expect(() => new AssistanceTraffic().grant({ ...binding, producer: "network", process: null, pool: "data", bytes: 1, entries: 1 })).toThrow();
});

it("VM installation traffic shares capacity without borrowing a process identity", async () => {
  const traffic = new AssistanceTraffic();
  const controller = new AbortController();
  const installation = traffic.reserve(null, "data", 15 * 1024 * 1024);
  expect(() => traffic.release(1, installation)).toThrow("stale");
  const read = traffic.acquire(1, 64 * 1024, controller.signal);
  expect(traffic.pendingEntries).toBe(2);
  traffic.release(null, installation);
  const processRead = await read;
  expect(traffic.pendingBytes).toBe(64 * 1024);
  expect(() => traffic.release(null, processRead)).toThrow("stale");
  traffic.release(1, processRead);
  expect(traffic.pendingBytes).toBe(0);
  expect(traffic.pendingEntries).toBe(0);
});

it("VM cancellation remains serviceable while process data exhausts the budget", async () => {
  const traffic = new AssistanceTraffic();
  const full = traffic.reserve(1, "data", 15 * 1024 * 1024);
  const controller = new AbortController();
  const pending = traffic.acquire(null, 64 * 1024, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  const stop = traffic.reserve(null, "control", 128);
  controller.abort();
  await rejected;
  traffic.release(null, stop);
  traffic.release(1, full);
  expect(traffic.pendingBytes).toBe(0);
  expect(traffic.pendingEntries).toBe(0);
});

it("shares one budget across bootstrap, broker and guest grants and validates exact returns", () => {
  const traffic = new AssistanceTraffic();
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const local = traffic.reserve(1, "data", 1024);
  const bootstrap = traffic.grant({ ...binding, producer: "bootstrap", process: null, pool: "data", bytes: 1024 * 1024, entries: 2 });
  const guest = traffic.grant({ ...binding, producer: "guest", process: 1, pool: "data", bytes: 14 * 1024 * 1024 - 1024, entries: 4 });
  expect(bootstrap.sequence).toBe(1);
  expect(bootstrap.reservation).toBeGreaterThan(local);
  expect(() => traffic.grant({ ...binding, producer: "broker", process: 1, pool: "data", bytes: 1, entries: 1 })).toThrow("capacity");
  const broker = traffic.grant({ ...binding, producer: "broker", process: 1, pool: "control", bytes: 1024 * 1024, entries: 1 });
  expect(traffic.pendingBytes).toBe(16 * 1024 * 1024);
  expect(traffic.pendingEntries).toBe(8);
  expect(() => traffic.release(1, guest.reservation)).toThrow();
  for (const patch of [{ generation: 2 }, { process: 2 }, { producer: "broker" }, { sequence: guest.sequence + 1 }, { bytes: guest.bytes - 1 }, { entries: 3 }]) {
    expect(() => traffic.returnCredit({ ...guest, kind: "return", ...patch })).toThrow();
    expect(traffic.pendingBytes).toBe(16 * 1024 * 1024);
  }
  expect(() => Reflect.set(guest, "bytes", 1)).not.toThrow();
  expect(guest.bytes).toBe(14 * 1024 * 1024 - 1024);
  traffic.returnCredit({ ...guest, kind: "return" });
  expect(() => traffic.returnCredit({ ...guest, kind: "return" })).toThrow();
  traffic.returnCredit({ ...bootstrap, kind: "return" });
  traffic.returnCredit({ ...broker, kind: "return" });
  traffic.release(1, local);
  expect(traffic.pendingBytes).toBe(0);
  expect(traffic.pendingEntries).toBe(0);
});

it("charges all producer queue entries and retires only the fenced binding's grants", () => {
  const traffic = new AssistanceTraffic();
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const grant = traffic.grant({ ...binding, producer: "guest", process: 1, pool: "data", bytes: 1, entries: 4096 });
  expect(() => traffic.reserve(2, "data", 1)).toThrow("capacity");
  traffic.retireGrants({ ...binding, generation: 2 }, 1, "guest");
  traffic.retireGrants(binding, 2, "guest");
  expect(traffic.pendingEntries).toBe(4096);
  traffic.retireGrants(binding, 1, "guest");
  expect(traffic.pendingEntries).toBe(0);
  expect(() => traffic.returnCredit({ ...grant, kind: "return" })).toThrow();
  const next = traffic.grant({ ...binding, producer: "guest", process: 2, pool: "data", bytes: 1, entries: 1 });
  expect(next.reservation).toBeGreaterThan(grant.reservation);
});

it("reserves supervisory progress inside the VM budget and returns every reservation once", () => {
  const traffic = new AssistanceTraffic();
  const data = traffic.reserve(1, "data", 15 * 1024 * 1024);
  expect(() => traffic.reserve(2, "data", 1)).toThrow("capacity");
  const control = traffic.reserve(2, "control", 1024 * 1024);
  expect(traffic.pendingBytes).toBe(16 * 1024 * 1024);
  expect(() => traffic.reserve(3, "control", 1)).toThrow("capacity");
  expect(() => traffic.release(2, data)).toThrow("reservation");
  expect(traffic.pendingBytes).toBe(16 * 1024 * 1024);
  traffic.release(1, data);
  expect(() => traffic.release(1, data)).toThrow("reservation");
  traffic.release(2, control);
  expect(traffic.pendingBytes).toBe(0);
  expect(traffic.reserve(1, "data", 1)).toBeGreaterThan(control);
});

it("bounds reservation entries and rejects invalid amounts before changing counters", () => {
  const traffic = new AssistanceTraffic();
  for (const bytes of [0, -1, NaN, Infinity, 0.5]) expect(() => traffic.reserve(1, "data", bytes)).toThrow();
  expect(traffic.pendingBytes).toBe(0);
  const reservations = Array.from({ length: 4096 }, () => traffic.reserve(1, "data", 1));
  expect(() => traffic.reserve(1, "data", 1)).toThrow("capacity");
  const supervisory = traffic.reserve(1, "control", 1);
  for (const id of reservations) traffic.release(1, id);
  traffic.release(1, supervisory);
  expect(traffic.pendingBytes).toBe(0);
});

it("backpressures data dispatch while retaining bounded cancellation progress", async () => {
  const traffic = new AssistanceTraffic();
  const full = traffic.reserve(1, "data", 15 * 1024 * 1024);
  const first = new AbortController(); const second = new AbortController();
  const cancelled = traffic.acquire(2, 1024, first.signal);
  const rejected = expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });
  const waiting = traffic.acquire(3, 1024, second.signal);
  expect(traffic.pendingEntries).toBe(3);
  first.abort(); await rejected;
  expect(traffic.pendingEntries).toBe(2);
  traffic.release(1, full);
  const granted = await waiting;
  expect(traffic.pendingEntries).toBe(1);
  expect(traffic.pendingBytes).toBe(1024);
  traffic.release(3, granted);
  expect(traffic.pendingBytes).toBe(0);
});

it("bounds waiting dispatch entries without consuming a data grant", async () => {
  const traffic = new AssistanceTraffic();
  const full = traffic.reserve(1, "data", 15 * 1024 * 1024);
  const controller = new AbortController();
  const pending = Array.from({ length: 128 }, () => traffic.acquire(2, 1, controller.signal));
  const outcomes = Promise.allSettled(pending);
  await expect(traffic.acquire(3, 1, controller.signal)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  controller.abort();
  expect((await outcomes).every(result => result.status === "rejected")).toBe(true);
  traffic.release(1, full);
  expect(traffic.pendingBytes).toBe(0);
});

it("bootstrap retirement preserves live VM producer reservations", () => {
  const traffic = new AssistanceTraffic(6);
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const bootstrap = traffic.grant({ ...binding, producer: "bootstrap", process: null, pool: "data", bytes: 100, entries: 1 });
  const network = traffic.grant({ ...binding, producer: "network", process: null, pool: "data", bytes: 200, entries: 1 });
  const storage = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: 300, entries: 1 });
  traffic.retireGrants(binding, null, "bootstrap");
  expect(traffic.pendingBytes).toBe(500);
  expect(traffic.pendingEntries).toBe(2);
  expect(() => traffic.returnCredit({ ...bootstrap, kind: "return" })).toThrow("stale");
  traffic.returnCredit({ ...network, kind: "return" });
  traffic.returnCredit({ ...storage, kind: "return" });
  expect(traffic.pendingBytes).toBe(0);
});
