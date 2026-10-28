import { expect, it } from "vitest";
import { readWorkspaceBlob } from "./workspace-backend.js";

it("cancels a pending OPFS blob read and awaits underlying retirement", async () => {
  const reading = Promise.withResolvers<undefined>();
  const cancelling = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  class PendingBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({
        pull: () => { reading.resolve(undefined); return new Promise<void>(() => { /* Wait for cancellation. */ }); },
        cancel: () => { cancelling.resolve(undefined); return retired.promise; },
      });
    }
  }
  const controller = new AbortController();
  let settled = false;
  const read = readWorkspaceBlob(new PendingBlob([new Uint8Array(1)]), 1, controller.signal);
  void read.then(() => { settled = true; }, () => { settled = true; });
  const cancelled = expect(read).rejects.toMatchObject({ code: "ABORTED" });
  await reading.promise;
  controller.abort();
  await cancelling.promise;
  expect(settled).toBe(false);
  retired.resolve(undefined);
  await cancelled;
});

it("bounds OPFS blob allocation and verifies complete reads", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  await expect(readWorkspaceBlob(blob, 3)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  await expect(readWorkspaceBlob(blob, 2)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const controller = new AbortController(); controller.abort();
  await expect(readWorkspaceBlob(blob, 3, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
});

it.each([1, 3])("rejects OPFS data whose size %i differs from the pinned size", async bytes => {
  class ChangedBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({ start: controller => { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
    }
  }
  await expect(readWorkspaceBlob(new ChangedBlob([new Uint8Array(2)]), 2)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it("does not hide failed blob retirement behind cancellation", async () => {
  const reading = Promise.withResolvers<undefined>();
  class FailedBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({
        pull: () => { reading.resolve(undefined); return new Promise<void>(() => { /* Cancel the read. */ }); },
        cancel: () => Promise.reject(new Error("retirement failed")),
      });
    }
  }
  const controller = new AbortController();
  const read = readWorkspaceBlob(new FailedBlob([new Uint8Array(1)]), 1, controller.signal);
  const failed = expect(read).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { cleanupFailed: true, reason: "workspace-producer-retirement-failed" },
  });
  await reading.promise;
  controller.abort();
  await failed;
});
