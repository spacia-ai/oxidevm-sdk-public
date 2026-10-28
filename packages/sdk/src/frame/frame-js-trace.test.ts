import { afterEach, expect, it, vi } from "vitest";
import type { UserspaceVM } from "../contracts.js";
import { configureJSProcessTrace, readJSProcessTrace } from "../js-process-diagnostics.js";
import { decodeFrameMessage, frameRequest } from "./protocol/requests.js";
import { bindFrameDiagnostics } from "../vm-adapter.js";
import { Writer } from "../runtime/js-process/codec.js";
import { closeChannels, connect, fakeVM } from "./frame-vm.test-support.js";

afterEach(closeChannels);

it("uses public trace exports across a hosted frame and retires access on disposal", async () => {
  const { vm } = fakeVM();
  const linux: UserspaceVM = { ...vm, mode: "userspace", image: { ...vm.image, mode: "userspace" }, spawnJS: vi.fn(() => Promise.reject(new Error("unused"))) };
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(7n).u32(0).u32(0).u32(0).finish();
  const read = vi.fn((capacity?: number) => { expect(capacity === undefined || capacity === 32).toBe(true); return Promise.resolve(bytes); });
  bindFrameDiagnostics(linux, { readJSProcessTrace: read, watchAccelerationNotices: () => Promise.reject(new Error("unused")) });
  const { client } = await connect(linux);
  if (client.mode !== "userspace") throw new Error("Expected Userspace frame");
  await configureJSProcessTrace(client, 32);
  expect(await readJSProcessTrace(client)).toEqual({ dropped: 7n, events: [], placements: [], failures: [] });
  expect(read.mock.calls).toEqual([[32], [undefined]]);
  await client.dispose();
  await expect(readJSProcessTrace(client)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("decodes bounded hosted trace requests and rejects extra fields", () => {
  expect(decodeFrameMessage(frameRequest(1, { type: "js-trace", capacity: 4096 }))).toEqual({ id: 1, type: "js-trace", capacity: 4096 });
  for (const capacity of [-1, 4097, 1.5, "1"]) expect(() => decodeFrameMessage({ ...frameRequest(1, { type: "js-trace" }), capacity })).toThrow();
  expect(() => decodeFrameMessage({ ...frameRequest(1, { type: "js-trace" }), environment: "secret" })).toThrow();
});

it("rejects unregistered VM copies through the diagnostics facade", async () => {
  const { client } = await connect(fakeVM().vm);
  const linux: UserspaceVM = { ...client, mode: "userspace", image: { ...client.image, mode: "userspace" }, spawnJS: vi.fn(() => Promise.reject(new Error("unused"))) };
  await expect(readJSProcessTrace(linux)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await client.dispose();
});
