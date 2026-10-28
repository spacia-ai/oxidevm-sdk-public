import { afterEach, expect, it, vi } from "vitest";
import type { UserspaceVM } from "../contracts.js";
import { watchAccelerationNotices } from "../js-process-diagnostics.js";
import type { AccelerationNotice } from "../js-process-diagnostics.js";
import { decodeFrameMessage, frameRequest } from "./protocol/requests.js";
import { FRAME_PROTOCOL_VERSION } from "./protocol/handshake.js";
import { bindFrameDiagnostics } from "../vm-adapter.js";
import { closeChannels, connect, fakeVM } from "./frame-vm.test-support.js";
import { decodeProcessId } from "../values.js";

afterEach(closeChannels);

function userspace(): UserspaceVM {
  const { vm } = fakeVM();
  return { ...vm, mode: "userspace", image: { ...vm.image, mode: "userspace" }, spawnJS: vi.fn(() => Promise.reject(new Error("unused"))) };
}

const sqlite: AccelerationNotice = { pid: decodeProcessId(42), session: decodeProcessId(40), kind: "unavailable-builtin", detail: "node:sqlite",
  message: "This program uses node:sqlite, which the fast path does not provide; its next run uses full Linux." };

it("watches acceleration notices across a hosted frame until the page aborts, and retires access on disposal", async () => {
  const host = userspace(), watching = Promise.withResolvers<{ readonly emit: (notice: AccelerationNotice) => void; readonly signal: AbortSignal }>();
  bindFrameDiagnostics(host, {
    readJSProcessTrace: () => Promise.reject(new Error("unused")),
    watchAccelerationNotices: (listener, signal) => {
      watching.resolve({ emit: listener, signal });
      return new Promise(resolve => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    },
  });
  const { client } = await connect(host);
  if (client.mode !== "userspace") throw new Error("Expected Userspace frame");
  const controller = new AbortController(), received: AccelerationNotice[] = [];
  const watch = watchAccelerationNotices(client, notice => { received.push(notice); }, { signal: controller.signal });
  const subscription = await watching.promise;
  subscription.emit(sqlite);
  await vi.waitFor(() => { expect(received).toEqual([sqlite]); });
  controller.abort();
  await expect(watch).resolves.toBeUndefined();
  await vi.waitFor(() => { expect(subscription.signal.aborted).toBe(true); });
  await client.dispose();
  await expect(watchAccelerationNotices(client, () => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("decodes the hosted subscription request exactly under frame protocol 16", () => {
  expect(FRAME_PROTOCOL_VERSION).toBe(16);
  expect(decodeFrameMessage(frameRequest(1, { type: "acceleration-notices" }))).toEqual({ id: 1, type: "acceleration-notices" });
  expect(() => decodeFrameMessage({ ...frameRequest(1, { type: "acceleration-notices" }), pid: 1 })).toThrow();
  expect(() => decodeFrameMessage({ ...frameRequest(1, { type: "acceleration-notices" }), v: 15 })).toThrow();
});

it("refuses System VMs, foreign copies and malformed watch options", async () => {
  const unused = { readJSProcessTrace: () => Promise.reject(new Error("unused")), watchAccelerationNotices: () => Promise.resolve() };
  await expect(watchAccelerationNotices({ ...userspace() }, () => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const { vm } = fakeVM(), linux = userspace();
  bindFrameDiagnostics(vm, unused); bindFrameDiagnostics(linux, unused);
  // @ts-expect-error a System VM has no Userspace notices
  await expect(watchAccelerationNotices(vm, () => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  // @ts-expect-error the listener must be a function
  await expect(watchAccelerationNotices(linux, "listener", { signal: new AbortController().signal })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  // @ts-expect-error the options need exactly an AbortSignal
  await expect(watchAccelerationNotices(linux, () => {}, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
