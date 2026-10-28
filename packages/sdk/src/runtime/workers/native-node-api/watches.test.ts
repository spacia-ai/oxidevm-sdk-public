import { expect, it } from "vitest";
import { type LinuxOperation, LinuxError } from "../../js-process/codec.js";
import { createNativeFileService } from "./files.js";

function fixture() {
  const operations: number[] = [];
  const pending = Promise.withResolvers<Uint8Array>();
  function reply<T>(operation: LinuxOperation<T>): T {
    operations.push(operation.number);
    return operation.decode({ value: operation.number === 294 ? 8n : operation.number === 254 ? 1n : 0n, bytes: new Uint8Array() });
  }
  const service = createNativeFileService({ sync: reply, async call(operation) {
    if (operation.number !== 0) return reply(operation);
    operations.push(operation.number); const bytes = await pending.promise;
    return operation.decode({ value: BigInt(bytes.length), bytes });
  } });
  return { service, operations, pending };
}

it("shares Rust watches and removes the native subscription only after its last Node watcher closes", async () => {
  const f = fixture();
  expect(f.service.callSync({ kind: "watch-add", path: "/workspace" })).toEqual({ kind: "watch-opened", watch: 1 });
  expect(f.service.callSync({ kind: "watch-add", path: "/workspace/." })).toEqual({ kind: "watch-opened", watch: 1 });
  const reading = f.service.call({ kind: "watch-read" });
  f.service.callSync({ kind: "watch-remove", watch: 1 });
  expect(f.operations).toEqual([294, 254, 254, 0]);
  f.service.callSync({ kind: "watch-remove", watch: 1 });
  expect(f.operations).toEqual([294, 254, 254, 0, 255]);
  const retired = new Uint8Array(16), view = new DataView(retired.buffer);
  view.setInt32(0, 1, true); view.setUint32(4, 0x8000, true);
  f.pending.resolve(retired);
  expect(await reading).toEqual({ kind: "watch-events", events: [{ sequence: 1n, watch: 1, change: "retired", mask: 0x8000, cookie: 0, name: null }] });
  expect(f.service.callSync({ kind: "watch-remove", watch: 1 })).toMatchObject({ kind: "error", code: "EINVAL" });
});

it("decodes Linux names without changing bytes and refuses truncated inotify records", async () => {
  for (const malformed of [false, true]) {
    const f = fixture(); f.service.callSync({ kind: "watch-add", path: "/workspace" });
    const reading = f.service.call({ kind: "watch-read" });
    const bytes = new Uint8Array(malformed ? 17 : 32), view = new DataView(bytes.buffer);
    view.setInt32(0, 1, true); view.setUint32(4, 2, true); view.setUint32(12, 16, true); bytes[16] = 255;
    f.pending.resolve(bytes);
    if (malformed) await expect(reading).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    else expect(await reading).toEqual({ kind: "watch-events", events: [{ sequence: 1n, watch: 1, change: "change", mask: 2, cookie: 0, name: Uint8Array.of(255) }] });
  }
});

it("keeps Linux errors distinct from transport failure when adding a watch", () => {
  const service = createNativeFileService({ sync() { throw new LinuxError(13); }, call() { return Promise.reject(new Error("unexpected async call")); } });
  expect(service.callSync({ kind: "watch-add", path: "/private" })).toMatchObject({ kind: "error", code: "EACCES" });
});

it("bounds subscriptions waiting for native retirement without dropping their identities", () => {
  let next = 0;
  const service = createNativeFileService({ sync(operation) { return operation.decode({ value: operation.number === 254 ? BigInt(++next) : 8n, bytes: new Uint8Array() }); }, call() { return Promise.reject(new Error("unexpected async call")); } });
  for (let i = 0; i < 8192; i++) service.callSync({ kind: "watch-add", path: `/directory-${String(i)}` });
  expect(() => service.callSync({ kind: "watch-add", path: "/exhausted" })).toThrow("Native watcher subscription limit exceeded");
  expect(next).toBe(8192);
});
