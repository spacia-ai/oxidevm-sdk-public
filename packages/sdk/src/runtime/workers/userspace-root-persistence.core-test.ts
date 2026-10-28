import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import { UserspaceRootPersistence } from "./userspace-root-persistence.js";
import { UserspaceRootStorage } from "./userspace-root-storage.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { serveUserspaceStorage } from "./userspace-storage-server.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { workspaceBytesInput } from "./workspace-stream.js";

it("cancels a paused root restore and confirms both retirements before reuse", async () => {
  const identity = "a".repeat(64), controller = new AbortController();
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" });
  expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
  expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const store = await openUserspaceRootStore(backend, identity);
  await store.commitStreams(identity, { snapshot: workspaceBytesInput(new Uint8Array([1])),
    delta: workspaceBytesInput(new Uint8Array()) }, new AbortController().signal);
  const owner = new UserspaceRootStorage(backend), channel = new MessageChannel();
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>();
  const requests: string[] = [];
  const server = serveUserspaceStorage(channel.port2, async (request, signal) => {
    requests.push(request.type);
    if (request.type === "read-root-overlay") {
      entered.resolve(signal);
      await Promise.race([release.promise, new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      })]);
    }
    return owner.handle(request, signal);
  });
  const client = new UserspaceStorageClient(channel.port1);
  const persistence = new UserspaceRootPersistence(runtime, client, identity, () => {}, () => {});
  const pending = persistence.initialize(controller.signal);
  const settled = pending.catch(() => {});
  try {
    const reading = await entered.promise;
    controller.abort();
    await vi.waitFor(() => expect(reading.aborted).toBe(true), { timeout: 500 });
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(requests).toContain("close-root-overlay");
    const id = call64(runtime.instance, "oxidevm_userspace_root_import_begin");
    expect(id).not.toBe(0n);
    expect(call(runtime.instance, "oxidevm_userspace_root_transfer_abort", id)).toBe(0);
  } finally {
    release.resolve(undefined); await settled;
    client.close(); await server.close(); await owner.close(); await runtime.jitRuntime.dispose();
  }
});

it("shares only acknowledged root bindings across consecutive restores and recovery", async () => {
  const identity = "a".repeat(64);
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" });
  expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
  expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
  const owner = new UserspaceRootStorage(opfsWorkspaceStoreBackend(new MemoryDirectory()));
  const channel = new MessageChannel(), generations: number[] = [];
  const server = serveUserspaceStorage(channel.port2, (request, signal) => {
    if (request.type === "open-root-overlay") generations.push(request.binding.generation);
    return owner.handle(request, signal);
  });
  const client = new UserspaceStorageClient(channel.port1);
  const original = new UserspaceRootPersistence(runtime, client, identity, () => {}, () => {});
  try {
    await original.initialize();
    const first = original.restored(runtime, identity, () => {}, () => {});
    const second = first.restored(runtime, identity, () => {}, () => {});
    // Two restores before any fsync must not invent two acknowledged storage generations.
    expect(generations).toEqual([1]);
    await expect(first.flush()).rejects.toMatchObject({ code: "ABORTED" });
    await second.flush();
    expect(generations).toEqual([1, 2]);
    // Preparing a failed replacement cannot consume a binding. Recovery uses the
    // same channel authority, including an already acknowledged rebind.
    second.restored(runtime, identity, () => {}, () => {});
    const recovered = original.restored(runtime, identity, () => {}, () => {});
    await recovered.flush();
    await recovered.flush();
    expect(generations).toEqual([1, 2, 3]);
  } finally { client.close(); await server.close(); await owner.close(); await runtime.jitRuntime.dispose(); }
});
