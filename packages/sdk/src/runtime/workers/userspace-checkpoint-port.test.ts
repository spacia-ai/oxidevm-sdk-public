import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { VMError } from "../errors.js";
import { UserspaceCheckpointPort } from "./userspace-checkpoint-port.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(handle: ConstructorParameters<typeof UserspaceCheckpointPort>[1]) {
  const channel = new MessageChannel();
  const server = new UserspaceCheckpointPort(channel.port1, handle);
  cleanup.push(() => { server.close(); channel.port2.close(); });
  const receive = () => new Promise<unknown>(resolve => channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => resolve(event.data), { once: true }));
  channel.port2.start();
  return { send: (message: unknown) => channel.port2.postMessage(message), receive };
}
describe("native checkpoint request port", () => {
  it("settles the original request after cancellation rolls back", async () => {
    const started = Promise.withResolvers<undefined>();
    const server = fixture((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new VMError("ABORTED", "rolled back")), { once: true }); started.resolve(undefined);
    }));
    const result = server.receive();
    server.send({ version: PROTOCOL_VERSION, id: 1, type: "capture", kind: "named" });
    await started.promise;
    server.send({ version: PROTOCOL_VERSION, type: "cancel", requestId: 1 });
    expect(await result).toMatchObject({ id: 1, ok: false, error: { code: "ABORTED" } });
  });
  it("reports a committed result even when cancellation arrives during publication", async () => {
    const started = Promise.withResolvers<undefined>(), committed = Promise.withResolvers<undefined>();
    const server = fixture(async (_request, signal) => { signal.addEventListener("abort", () => committed.resolve(undefined), { once: true }); started.resolve(undefined); await committed.promise; return true; });
    const result = server.receive(); server.send({ version: PROTOCOL_VERSION, id: 2, type: "dirty" }); await started.promise;
    server.send({ version: PROTOCOL_VERSION, type: "cancel", requestId: 2 });
    expect(await result).toMatchObject({ id: 2, ok: true, value: true });
  });
  it("rejects malformed messages before invoking the transaction", async () => {
    let calls = 0;
    const server = fixture(() => { calls++; return Promise.resolve(undefined); });
    const result = server.receive(); server.send({ version: PROTOCOL_VERSION, id: 3, type: "dirty", extra: true });
    expect(await result).toMatchObject({ id: 3, ok: false, error: { code: "PROTOCOL_ERROR" } }); expect(calls).toBe(0);
  });
});
