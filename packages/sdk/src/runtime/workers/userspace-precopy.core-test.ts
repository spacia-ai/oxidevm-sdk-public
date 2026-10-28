import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeUserspaceFileRecord, encodeUserspaceFileRequest, type UserspaceFileRequest } from "../userspace-files.js";
import { readFileRecord } from "./userspace-files.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { NativePayloadRounds } from "./snapshot-native-payload-rounds.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import type { CheckpointInput } from "./userspace-checkpoint.js";

function input(chunks: readonly Uint8Array[]): CheckpointInput {
  return { bytes: chunks.reduce((total, bytes) => total + bytes.length, 0),
    frames: (async function* () { for (const chunk of chunks) yield await Promise.resolve(chunk); })(), retire: () => Promise.resolve() };
}
it("merges actual native dirty rounds and restores final host edits with deleted files pruned", async () => {
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "checkpoint-precopy-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array): void => {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.length)).toBe(0);
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.length).set(bytes);
  };
  const file = (request: UserspaceFileRequest) => {
    const bytes = encodeUserspaceFileRequest(request); stage(bytes);
    expect(call(runtime.instance, "oxidevm_userspace_files", bytes.length)).toBe(0);
    return decodeUserspaceFileRecord(readFileRecord(runtime), request);
  };
  try {
    stage(new Uint8Array()); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", 0, 1, 64)).toBe(0);
    file({ operation: "write", path: "/kept", data: new Uint8Array(70_000).fill(1) });
    file({ operation: "write", path: "/gone", data: new Uint8Array(10_000).fill(2) });
    const rounds = new NativePayloadRounds(await SnapshotObjects.open(new MemoryDirectory()));
    const capture = runtime.checkpoints.beginPrecopy(new Uint8Array(32));
    rounds.beginRound(0);
    const first = await capture.transferRound((index, bytes) => rounds.putRound(0, index, bytes));
    await rounds.sealRound(0, first.payloadBytes); capture.commitRound();
    file({ operation: "write", path: "/kept", data: new Uint8Array(70_000).fill(3) });
    file({ operation: "remove", path: "/gone", recursive: false });
    rounds.beginRound(1);
    const changed = await capture.transferRound((index, bytes) => rounds.putRound(1, index, bytes));
    await rounds.sealRound(1, changed.payloadBytes); capture.commitRound();
    rounds.beginRound(2);
    const clean = await capture.transferRound((index, bytes) => rounds.putRound(2, index, bytes));
    await rounds.sealRound(2, clean.payloadBytes); capture.commitRound();
    expect(clean.payloadBytes).toBeLessThan(changed.payloadBytes);
    const graph: Uint8Array[] = [], payloads: Uint8Array[] = [];
    rounds.beginRound(3);
    const final = await capture.finalize((area, index, bytes) => {
      if (area === "payloads") return rounds.putRound(3, index, bytes);
      graph.push(bytes); return Promise.resolve();
    }, (index, bytes) => rounds.putLiveIndex(index, bytes));
    await rounds.sealRound(3, final.payloadBytes); await rounds.sealLiveIndex(final.liveIndexBytes);
    await rounds.consolidate((_index, bytes) => { payloads.push(bytes); return Promise.resolve(); });
    capture.finish(true);
    const restore = runtime.checkpoints.beginRestore(new Uint8Array(32));
    await restore.read(input(graph), input(payloads)); restore.complete();
    expect(file({ operation: "read", path: "/kept", maxBytes: 100_000 })).toMatchObject({ operation: "read", data: new Uint8Array(70_000).fill(3) });
    expect(() => file({ operation: "stat", path: "/gone" })).toThrow();
  } finally { await runtime.jitRuntime.dispose(); }
});
