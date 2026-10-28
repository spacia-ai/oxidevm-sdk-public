import { expect, it, vi } from "vitest";
import { UserspacePreviewRuntime } from "./userspace-preview-runtime.js";

it("fences requests queued across restore and cancellation before native effects", async () => {
  let epoch = {};
  let release = Promise.withResolvers<undefined>();
  const processes = vi.fn(() => []);
  const runtime = new UserspacePreviewRuntime({
    gate: { deliver: async run => { await release.promise; run(); } },
    epoch: () => epoch, processes, opened: vi.fn(), closed: vi.fn(),
  });
  const operation = { kind: "read", generation: 1n, process: 1, connection: 2, maxBytes: 64 } as const;
  const pending = runtime.request(operation, new AbortController().signal);
  epoch = {}; release.resolve(undefined);
  await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  expect(processes).not.toHaveBeenCalled();
  release = Promise.withResolvers<undefined>();
  const stop = new AbortController();
  const cancelled = runtime.request(operation, stop.signal);
  stop.abort(); release.resolve(undefined);
  await expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });
  expect(processes).not.toHaveBeenCalled();
});
