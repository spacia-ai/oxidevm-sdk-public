import { expect, it, vi } from "vitest";
import { GrantedTraffic } from "./assistance/traffic.js";
import { SystemListeners } from "./system-listeners.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, producer: "network", process: null } as const;
function listeners() {
  const grant = { ...binding, kind: "grant", pool: "data", bytes: 1024 * 1024, entries: 8, sequence: 1, reservation: 1 } as const;
  return new SystemListeners(new GrantedTraffic(binding, [grant, { ...grant, pool: "control", bytes: 64 * 1024, sequence: 2, reservation: 2 }], 6));
}

it("resolves a preview port to the task whose listener is reachable on loopback", () => {
  const owner = listeners();
  owner.openTask(1); owner.openTask(2);
  owner.open(1, 5, { address: "0.0.0.0", port: 3000 });
  owner.open(2, 6, { address: "127.0.0.1", port: 3001 });
  owner.open(2, 7, { address: "10.0.0.7", port: 3002 });
  owner.open(2, 8, { address: "::", port: 3003 });
  expect(owner.resolve(3000)).toBe(1);
  expect(owner.resolve(3001)).toBe(2);
  expect(owner.resolve(3002)).toBeUndefined();
  expect(owner.resolve(3003)).toBe(2);
  expect(owner.resolve(4000)).toBeUndefined();
  owner.close(1, 5);
  expect(owner.resolve(3000)).toBeUndefined();
});

it("waits for a listener that opens later and rejects waiters on cancellation or retirement", async () => {
  const owner = listeners();
  owner.openTask(1);
  const controller = new AbortController();
  const waiting = owner.waitFor(3000, controller.signal);
  const cancelled = owner.waitFor(3000, new AbortController().signal);
  const retired = owner.waitFor(3001, controller.signal);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  owner.open(1, 5, { address: "0.0.0.0", port: 3000 });
  await expect(waiting).resolves.toBe(1);
  await expect(cancelled).resolves.toBe(1);
  await expect(owner.waitFor(3000, controller.signal)).resolves.toBe(1);
  controller.abort();
  await expect(retired).rejects.toMatchObject({ code: "ABORTED" });
  const pending = owner.waitFor(3002, new AbortController().signal);
  owner.retire();
  await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
});

it("tells preview owners when a task retires so its proxied connections end", () => {
  const owner = listeners();
  const closed = vi.fn();
  const unsubscribe = owner.onTaskClosed(closed);
  owner.openTask(1); owner.openTask(2);
  owner.closeTask(1);
  expect(closed).toHaveBeenCalledWith(1);
  unsubscribe();
  owner.closeTask(2);
  expect(closed).toHaveBeenCalledTimes(1);
});
