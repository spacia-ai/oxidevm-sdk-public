import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { instantiateRuntime } from "./userspace-runtime.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { CheckpointInput } from "./userspace-checkpoint.js";

function input(chunks: readonly Uint8Array[]): CheckpointInput {
  return { bytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0), frames: (async function* () {
    for (const chunk of chunks) yield await Promise.resolve(chunk);
  })(), retire: () => Promise.resolve() };
}

// The worker binds a restored runtime's workspace persistence when the restore is published
// (userspace.worker.ts, bindWorkspacePersistence): its first call, the capture reset, is refused
// while the native checkpoint candidate is unpublished, which failed every Userspace restore.
it("the native runtime resets workspace capture only after a restore is published", async () => {
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "restore-workspace-test", { kind: "disabled" });
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_configure_workspace_persistence")).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_workspace_capture_reset")).toBe(0);
    const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
    const capture = runtime.checkpoints.beginCapture(new Uint8Array(32));
    await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); }); capture.finish(true);
    const restore = runtime.checkpoints.beginRestore(new Uint8Array(32));
    await restore.read(input(chunks.graph), input(chunks.payloads)); restore.prepare();
    expect(call(runtime.instance, "oxidevm_userspace_workspace_capture_reset")).not.toBe(0);
    restore.complete();
    expect(call(runtime.instance, "oxidevm_userspace_workspace_capture_reset")).toBe(0);
  } finally { await runtime.jitRuntime.dispose(); }
});
