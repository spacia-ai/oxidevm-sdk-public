import { afterEach, expect, it, vi } from "vitest";
import { NativeCallbacks } from "./callbacks.js";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("claims callbacks for their module and retires cancelled finalizers once", () => {
  const events: unknown[][] = [], callbacks = new NativeCallbacks(7n << 32n, {
    claim: (id, environment) => { events.push(["claim", id, environment]); },
    retire: id => { events.push(["retire", id]); }, finalize: id => { events.push(["finalize", id]); },
  });
  const id = (7n << 32n) | 4096n;
  callbacks.add({}, id, "finalizer", (7n << 32n) | 1n);
  callbacks.cancel(id); callbacks.cancel(id); callbacks.dispose();
  expect(events).toEqual([["claim", id, (7n << 32n) | 1n], ["retire", id]]);
  expect(() => callbacks.add({}, id, "function", 0n)).toThrow();
});

it("fences stale generations and other threads before claiming native ownership", () => {
  const claims: bigint[] = [], callbacks = new NativeCallbacks(0n, { claim: id => { claims.push(id); }, retire: () => undefined, finalize: () => undefined });
  callbacks.add({}, 4096n, "function", 0n);
  expect(() => callbacks.add({}, 8192n, "function", 0n)).toThrow();
  callbacks.cancel(4096n);
  callbacks.add({}, 8192n, "function", 0n);
  for (const id of [0n, 1n, 4096n, 8192n, 0x1_0000_1000n]) expect(() => callbacks.add({}, id, "function", 0n)).toThrow();
  expect(claims).toEqual([4096n, 8192n]); callbacks.dispose();
});

it("keeps functions callable while finalizers run and releases them at final retirement", () => {
  const events: string[] = [], callbacks = new NativeCallbacks(0n, {
    claim: () => undefined, retire: id => { events.push(`retire:${String(id)}`); },
    finalize: id => { expect(callbacks.active(4096n)).toBe(true); events.push(`finalize:${String(id)}`); },
  });
  callbacks.add({}, 4096n, "function", 0n); callbacks.add({}, 4097n, "finalizer", 0n);
  callbacks.finalize(); expect(callbacks.active(4096n)).toBe(true);
  callbacks.dispose(); callbacks.dispose(); expect(callbacks.active(4096n)).toBe(false);
  expect(events).toEqual(["finalize:4097", "retire:4096"]);
});

it("uses controlled collection to release functions and ignores queued callbacks after cancellation", async () => {
  let collect: ((id: bigint) => void) | undefined;
  vi.stubGlobal("FinalizationRegistry", class { constructor(callback: (id: bigint) => void) { collect = callback; } register() {} unregister() { return true; } });
  vi.resetModules(); const { NativeCallbacks: ControlledCallbacks } = await import("./callbacks.js");
  const retired: bigint[] = [], callbacks = new ControlledCallbacks(0n, { claim: () => undefined, retire: id => { retired.push(id); }, finalize: () => undefined });
  callbacks.add({}, 4096n, "function", 0n); callbacks.add({}, 4097n, "function", 0n);
  callbacks.cancel(4097n); collect?.(4097n); collect?.(4096n); collect?.(4096n);
  expect(retired).toEqual([4097n, 4096n]); expect(callbacks.live).toBe(0);
});
