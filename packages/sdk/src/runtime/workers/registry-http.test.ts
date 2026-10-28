import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import { expect, it, vi } from "vitest";
import { openRegistryHttp } from "./registry-http.js";
import type { RegistryClient } from "./registry-client.js";

const envelope = { version: REGISTRY_PROTOCOL_VERSION, session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 2, correlation: 1, request: 7, reservation: 4 } as const;
it("passes real registry delivery acknowledgements through the HTTP port", async () => {
  const acknowledge = vi.fn(); const cancel = vi.fn(() => Promise.resolve());
  const client: Pick<RegistryClient, "start" | "read" | "cancel"> = {
    start: vi.fn<RegistryClient["start"]>(() => ({ identity: Promise.resolve(7), response: Promise.resolve({ value: { ...envelope, kind: "headers", status: 200, headers: [["content-type", "application/octet-stream"]] }, acknowledge }) })),
    read: vi.fn<RegistryClient["read"]>(() => Promise.resolve({ value: { ...envelope, kind: "data", bytes: new Uint8Array([1, 2]), done: true }, acknowledge })), cancel,
  };
  const response = await openRegistryHttp(client, "https://registry.npmjs.org/pkg", new AbortController().signal);
  response.acknowledgeHeaders(); const data = await response.read(); data.acknowledge();
  expect([...data.bytes]).toEqual([1, 2]); expect(data.done).toBe(true); expect(acknowledge).toHaveBeenCalledTimes(2);
  await response.cancel(); await response.cancel(); expect(cancel).toHaveBeenCalledExactlyOnceWith(7);
});
it("cancels before headers using the early identity and waits for retirement", async () => {
  const identity = Promise.withResolvers<number>();
  const retirement = Promise.withResolvers<undefined>();
  const cancelled = Promise.withResolvers<number>();
  const client: Pick<RegistryClient, "start" | "read" | "cancel"> = {
    start() { return { identity: identity.promise, response: new Promise(() => {}) }; },
    read() { throw new Error("unexpected read"); },
    cancel(request) { cancelled.resolve(request); return retirement.promise; },
  };
  const signal = new AbortController();
  const opening = openRegistryHttp(client, "https://registry.npmjs.org/pkg", signal.signal);
  let settled = false; void opening.then(() => { settled = true; }, () => { settled = true; });
  signal.abort(); identity.resolve(7);
  expect(await cancelled.promise).toBe(7); expect(settled).toBe(false);
  retirement.resolve(undefined); await expect(opening).rejects.toMatchObject({ name: "AbortError" });
});
it("retains cleanup failure when cancellation interrupts a pending body", async () => {
  const cancelled = Promise.withResolvers<undefined>();
  const client: Pick<RegistryClient, "start" | "read" | "cancel"> = {
    start() { return { identity: Promise.resolve(7), response: Promise.resolve({ value: { ...envelope, kind: "headers", status: 200, headers: [] }, acknowledge() {} }) }; },
    read() { return new Promise(() => {}); }, cancel() { return cancelled.promise; },
  };
  const signal = new AbortController(); const response = await openRegistryHttp(client, "https://registry.npmjs.org/pkg", signal.signal);
  const reading = expect(response.read()).rejects.toMatchObject({ name: "AbortError" });
  signal.abort(); await reading;
  const retirement = expect(response.cancel()).rejects.toThrow("retirement uncertain");
  cancelled.reject(new Error("retirement uncertain")); await retirement;
  await expect(response.cancel()).rejects.toThrow("retirement uncertain");
});
it("explicit cancellation interrupts a blocked read without waiting for its response", async () => {
  const retirement = Promise.withResolvers<undefined>();
  const client: Pick<RegistryClient, "start" | "read" | "cancel"> = {
    start() { return { identity: Promise.resolve(7), response: Promise.resolve({ value: { ...envelope, kind: "headers", status: 200, headers: [] }, acknowledge() {} }) }; },
    read() { return new Promise(() => {}); }, cancel() { return retirement.promise; },
  };
  const response = await openRegistryHttp(client, "https://registry.npmjs.org/pkg", new AbortController().signal);
  const reading = expect(response.read()).rejects.toMatchObject({ code: "ABORTED" });
  const cancelling = response.cancel();
  await reading;
  retirement.resolve(undefined); await cancelling;
});
