import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { instantiateRuntime } from "./userspace-runtime.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { CheckpointInput } from "./userspace-checkpoint.js";

function input(chunks: readonly Uint8Array[]): CheckpointInput {
  return { bytes: chunks.reduce((total, bytes) => total + bytes.length, 0),
    frames: (async function* () { for (const chunk of chunks) yield await Promise.resolve(chunk); })(), retire: () => Promise.resolve() };
}
it("round-trips a mounted real ABI37 runtime through bounded graph and payload streams", async () => {
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "checkpoint-test", { kind: "disabled" });
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
    const before = runtime.checkpoints.incarnation;
    runtime.checkpoints.pauseClock();
    runtime.checkpoints.resumeClock(); // A cancelled pre-capture flush reattaches the same owner.
    runtime.checkpoints.pauseClock();
    const capture = runtime.checkpoints.beginCapture(new Uint8Array(32));
    const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
    const sizes = await capture.transfer((area, index, bytes) => {
      expect(index).toBe(chunks[area].length); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024);
      chunks[area].push(bytes); return Promise.resolve();
    });
    expect(sizes.graphBytes).toBeGreaterThan(49);
    capture.finish(true);
    runtime.checkpoints.resumeClock(); // Capture consumed the native pause; finishing it is idempotent.
    expect(runtime.checkpoints.acknowledgedDirty).toBe(runtime.checkpoints.dirty);
    runtime.checkpoints.pauseClock();
    const restore = runtime.checkpoints.beginRestore(new Uint8Array(32));
    await restore.read(input(chunks.graph), input(chunks.payloads));
    expect(restore.recoveryRequired).toBe(true);
    expect(runtime.checkpoints.incarnation).toBe(before);
    restore.complete();
    runtime.checkpoints.resumeClock();
    expect(runtime.checkpoints.incarnation).toBeGreaterThan(before);
    const recapture = runtime.checkpoints.beginCapture(new Uint8Array(32));
    await recapture.transfer(() => Promise.resolve()); recapture.finish(false);
  } finally { await runtime.jitRuntime.dispose(); }
});

it("replays committed recovery in the same Wasm instance after destructive restore staging", async () => {
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "checkpoint-recovery-test", { kind: "disabled" });
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", 0)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
    const original = runtime.checkpoints.incarnation, chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
    const capture = runtime.checkpoints.beginCapture(new Uint8Array(32));
    await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); }); capture.finish(true);
    const candidate = runtime.checkpoints.beginRestore(new Uint8Array(32));
    await candidate.read(input(chunks.graph), input(chunks.payloads));
    const failedRecovery = runtime.checkpoints.beginRecovery(new Uint8Array(32));
    await expect(failedRecovery.read(input([]), input([new Uint8Array(16)]))).rejects.toMatchObject({ detail: { recoveryRequired: true } });
    const recovery = runtime.checkpoints.beginRecovery(new Uint8Array(32));
    await recovery.read(input(chunks.graph), input(chunks.payloads)); recovery.complete();
    expect(runtime.checkpoints.incarnation).toBeGreaterThan(original);
    expect(() => candidate.complete()).toThrow();
  } finally { await runtime.jitRuntime.dispose(); }
});
