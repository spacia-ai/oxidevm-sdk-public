import { expect, it, vi } from "vitest";
import { UserspacePreviewWaits } from "./userspace-preview-waits.js";

function fixture() {
  const cancelled: number[] = [], ready: bigint[] = [];
  let next = 0;
  const instance: WebAssembly.Instance = { exports: {
    oxidevm_userspace_preview_generation: () => 1n,
    oxidevm_userspace_preview_wait: () => BigInt(++next),
    oxidevm_userspace_preview_wait_cancel: (_generation: bigint, id: number) => { cancelled.push(id); return 0; },
    oxidevm_userspace_preview_wait_next: () => ready.shift() ?? 0n,
  } };
  return { waits: new UserspacePreviewWaits(instance), ready, cancelled, instance };
}
const operation = { kind: "wait", generation: 1n, process: 1, connection: 2, interest: "read" } as const;

it("waits without timers and removes cancellation listeners when Rust reports readiness", async () => {
  const { waits, ready, cancelled } = fixture(), controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = waits.wait(operation, controller.signal);
  waits.pump();
  ready.push(1n); waits.pump();
  await expect(pending).resolves.toEqual({ kind: "ready" });
  expect(remove).toHaveBeenCalledOnce();
  controller.abort();
  expect(cancelled).toEqual([]);
});

it("retires cancelled and disposed waits in Rust without resolving a stale request", async () => {
  const { waits, cancelled } = fixture(), controller = new AbortController();
  const pending = waits.wait(operation, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort(); await rejected;
  expect(cancelled).toEqual([1]);
  const next = waits.wait(operation, new AbortController().signal);
  const disposed = expect(next).rejects.toMatchObject({ code: "ABORTED" });
  waits.close(); await disposed;
  expect(cancelled).toEqual([1, 2]);
  await expect(waits.wait(operation, new AbortController().signal)).rejects.toMatchObject({ code: "ABORTED" });
});

it("retains a Linux failure separately from readiness and rejects malformed or stale completions", async () => {
  const { waits, ready } = fixture();
  const pending = waits.wait(operation, new AbortController().signal);
  ready.push((9n << 32n) | 1n); waits.pump();
  await expect(pending).resolves.toEqual({ kind: "error", code: "read" });
  ready.push(999n);
  expect(() => waits.pump()).toThrow(/stale/iu);
  const malformed = fixture();
  malformed.ready.push(1n << 63n);
  expect(() => malformed.waits.pump()).toThrow(/invalid/iu);
});

it("retires promises and listeners when the readiness transport fails", async () => {
  const { waits, ready } = fixture(), controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = waits.wait(operation, controller.signal);
  const failed = expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  ready.push(999n);
  expect(() => waits.pump()).toThrow(/stale/iu);
  await failed;
  expect(remove).toHaveBeenCalledOnce();
  await expect(waits.wait(operation, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
});

it("does not send old IDs after heap replacement or admit a different generation", async () => {
  const { waits, cancelled } = fixture();
  await expect(waits.wait({ ...operation, generation: 2n }, new AbortController().signal)).resolves.toEqual({ kind: "error", code: "process" });
  const pending = waits.wait(operation, new AbortController().signal);
  const retired = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  waits.retire(); await retired;
  expect(cancelled).toEqual([]);
});
