import { expect, it } from "vitest";
import { installationCapture } from "./installation-capture.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1 };
const reply = (result: InstallationReply["result"]): InstallationReply => ({ ...binding, result });

it("rejects failed capture at EOF while retaining confirmed retirement", async () => {
  let reads = 0; let retirements = 0;
  const capture = installationCapture(1, operation => {
    if (operation.kind === "capture-retire") { retirements++; return Promise.resolve(reply({ kind: "capture-retired", errno: 5 })); }
    return Promise.resolve(reply({ kind: "data", bytes: reads++ === 0 ? Uint8Array.of(7) : new Uint8Array() }));
  });
  const producer = capture.source(new AbortController().signal);
  const frames = producer.frames[Symbol.asyncIterator]();
  expect((await frames.next()).value).toEqual(Uint8Array.of(7));
  await expect(frames.next()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await expect(producer.retire()).resolves.toBeUndefined();
  expect(retirements).toBe(1);
});

it("cancellation retires before waiting on the blocked read", async () => {
  const read = Promise.withResolvers<InstallationReply>();
  const started = Promise.withResolvers<undefined>();
  const capture = installationCapture(1, async operation => {
    if (operation.kind === "capture-read") { started.resolve(undefined); return read.promise; }
    read.resolve(reply({ kind: "error", errno: 125 }));
    return reply({ kind: "capture-retired", errno: 125 });
  });
  const abort = new AbortController();
  const producer = capture.source(abort.signal);
  const pulling = producer.frames[Symbol.asyncIterator]().next();
  const rejected = expect(pulling).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  abort.abort();
  await producer.retire();
  await rejected;
});

it("keeps up to four reads in flight and delivers frames in request order", async () => {
  const { CAPTURE_READ_WINDOW } = await import("./installation-capture.js");
  expect(CAPTURE_READ_WINDOW).toBe(4);
  const pending: PromiseWithResolvers<InstallationReply>[] = [];
  let inFlight = 0; let peak = 0; let issued = 0;
  const capture = installationCapture(6 * 65536, operation => {
    if (operation.kind === "capture-retire") return Promise.resolve(reply({ kind: "capture-retired", errno: 0 }));
    inFlight += 1; peak = Math.max(peak, inFlight); issued += 1;
    const read = Promise.withResolvers<InstallationReply>();
    pending.push(read);
    return read.promise.finally(() => { inFlight -= 1; });
  });
  const producer = capture.source(new AbortController().signal);
  const frames = producer.frames[Symbol.asyncIterator]();
  const first = frames.next();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(issued).toBe(CAPTURE_READ_WINDOW);
  // Replies settle in order; each completion admits one more read.
  const chunk = (value: number) => new Uint8Array(65536).fill(value);
  pending[0]?.resolve(reply({ kind: "data", bytes: chunk(1) }));
  const firstBytes = (await first).value;
  if (!(firstBytes instanceof Uint8Array)) throw new Error("Capture did not deliver bytes");
  expect(firstBytes.byteLength).toBe(65536); expect(firstBytes.every(value => value === 1)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(issued).toBe(CAPTURE_READ_WINDOW + 1);
  for (let index = 1; index < 6; index += 1) {
    pending[index]?.resolve(reply({ kind: "data", bytes: chunk(index + 1) }));
    const bytes = (await frames.next()).value;
    if (!(bytes instanceof Uint8Array)) throw new Error("Capture did not deliver bytes");
    expect(bytes.byteLength).toBe(65536); expect(bytes.every(value => value === index + 1)).toBe(true);
  }
  pending[6]?.resolve(reply({ kind: "data", bytes: new Uint8Array() }));
  expect((await frames.next()).done).toBe(true);
  expect(peak).toBe(CAPTURE_READ_WINDOW);
});
