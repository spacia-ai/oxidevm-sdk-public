import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeUserspaceFileRecord, encodeUserspaceFileRequest, type UserspaceFileRequest } from "../userspace-files.js";
import { readFileRecord } from "./userspace-files.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { CheckpointInput,ReconcileSource } from "./userspace-checkpoint.js";
function input(chunks: readonly Uint8Array[]): CheckpointInput {
  return { bytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0), frames: (async function* () {
    for (const chunk of chunks) yield await Promise.resolve(chunk);
  })(), retire: () => Promise.resolve() };
}
function records(content?: string): Uint8Array {
  const path = new TextEncoder().encode("/workspace/a"), payload = new TextEncoder().encode(content ?? "");
  const bytes = new Uint8Array(content === undefined ? 12 : 24 + path.length + payload.length), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXRF")); view.setUint16(4, 5, true); view.setUint32(8, content === undefined ? 0 : 1, true);
  if (content !== undefined) {
    bytes[12] = 1; view.setUint16(14, 0o644, true); view.setUint32(16, path.length, true); view.setUint32(20, payload.length, true);
    bytes.set(path, 24); bytes.set(payload, 24 + path.length);
  }
  return bytes;
}
it.each([
  {name:"same base",guest:"guest",base:undefined,ancestor:"old",foreign:undefined,unknown:false,current:"new",expected:"new",needs:[3] as readonly ReconcileSource[]},
  {name:"foreign verified base",guest:"selected",base:"selected",ancestor:"selected",foreign:"previous",unknown:false,current:"user",expected:"user",needs:[3] as readonly ReconcileSource[]},
  {name:"unknown snapshot base",guest:"selected",base:"selected",ancestor:"selected",foreign:undefined,unknown:true,current:"foreign",expected:"selected",needs:[] as readonly ReconcileSource[]},
])("reconciles a real unpublished restored VFS: $name", async scenario => {
  const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);
  const runtime = await instantiateRuntime(module, "checkpoint-reconcile-test", { kind: "disabled" });
  const stage = (bytes: Uint8Array) => {
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
    expect(call(runtime.instance, "oxidevm_userspace_configure_workspace_persistence")).toBe(0);
    file({ operation: "write", path: "/a", data: new TextEncoder().encode(scenario.guest) });
    const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
    const capture = runtime.checkpoints.beginCapture(new Uint8Array(32));
    await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); }); capture.finish(true);
    const before = runtime.checkpoints.incarnation, restore = runtime.checkpoints.beginRestore(new Uint8Array(32));
    await restore.read(input(chunks.graph), input(chunks.payloads)); restore.prepare();
    expect(runtime.checkpoints.incarnation).toBe(before);
    const preserved="123e4567-e89b-42d3-a456-426614174001",transfer = restore.beginReconcile("point-1",preserved);
    const sources:[ReconcileSource,Uint8Array][]=[[0,records(scenario.base)],[1,records(scenario.ancestor)]];
    if(scenario.foreign!==undefined)sources.push([5,records(scenario.foreign)]);
    if(scenario.unknown)sources.push([6,records()]);
    sources.push([3,records(scenario.current)]);
    for (const [source, bytes] of sources) {
      transfer.source(source, bytes.length);
      for (let offset = 0; offset < bytes.length; offset += 7) transfer.feed(bytes.subarray(offset, offset + 7));
      transfer.sourceComplete();
    }
    expect(transfer.plan()).toEqual({ sources: scenario.needs, hosts: 0 });
    transfer.apply(); for(const source of scenario.needs){transfer.replay(source);transfer.replayFeed(records(scenario.current));transfer.replayComplete();}
    expect(transfer.finish()).toEqual({ workspace: { workspace: "conflict-preserved", unresolved: [] },
      workspaceDetails: { state: "conflict-preserved", conflicts: scenario.unknown?[]:[{ path: "/workspace/a", reason: "changed-in-both" }], omittedConflicts: 0,...(scenario.unknown?{preserved:{id:preserved,reason:"base-unavailable"}}:{}) } });
    expect(runtime.checkpoints.incarnation).toBe(before);
    const exported = restore.exportWorkspace();
    const producer = exported.snapshot.source(new AbortController().signal);
    let exportedBytes = 0;
    for await (const frame of producer.frames) { expect(frame.length).toBeLessThanOrEqual(65536); exportedBytes += frame.length; }
    await producer.retire();
    expect(exportedBytes).toBe(exported.snapshot.bytes);
    expect(runtime.checkpoints.incarnation).toBe(before);
    // Storage has selected these exact drained bytes before native durability is acknowledged.
    exported.complete(true); restore.complete();
    expect(runtime.checkpoints.incarnation).toBeGreaterThan(before);
    expect(runtime.checkpoints.dirty).toBeGreaterThan(runtime.checkpoints.acknowledgedDirty);
    expect(file({ operation: "read", path: "/a", maxBytes: 64 })).toMatchObject({ operation: "read", data: new TextEncoder().encode(scenario.expected) });
  } finally { await runtime.jitRuntime.dispose(); }
});
