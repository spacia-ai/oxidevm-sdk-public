import {AssistanceTraffic} from "./control/assistance-traffic.js";
import {transferWorkspaceStream} from "./workspace-transfer.js";
import {WORKSPACE_PUBLICATION_BYTES,decodeWorkspacePublicationResult} from "../protocol/workspace-publication.js";
import {vi} from "vitest";
import { expect, it } from "vitest";
import { NativeSnapshotStore, type NativeSnapshotEnvironment } from "./snapshot-native-store.js";
import { SnapshotCatalog } from "./snapshot-catalog.js";
import { SnapshotObjects, type SnapshotReadLease } from "./snapshot-objects.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { WorkspaceStore } from "./workspace-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { decodeSnapshotStorageRequest, SNAPSHOT_CHANNEL_VERSION } from "./snapshot-channel.js";
import { checkpointHeader, encodeCheckpointDeclaration } from "./userspace-checkpoint.js";
import { nativeGraphFixture } from "./userspace-checkpoint.test-support.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";

const BASE = "a".repeat(64);
const ROOT = "b".repeat(64);
const signal = () => new AbortController().signal;
const ref = (n: number) => ({ id: `11111111-2222-4333-8444-55555555555${String(n)}`, createdAt: "2026-10-13T10:00:00.000Z" });
const destination = { manifestUrl: "https://example.com/rootfs.json", trusted: { keyId: "test", publicKey: new Uint8Array(32) } };

it("refuses pre-fast-path storage protocol messages before handling their requests", () => {
  expect(SNAPSHOT_CHANNEL_VERSION).toBe(15);
  expect(() => decodeSnapshotStorageRequest({version:13,id:1,request:{type:"abort"}})).toThrow();
  expect(() => decodeSnapshotStorageRequest({version:12,id:1,request:{type:"abort"}})).toThrow();
  expect(() => decodeSnapshotStorageRequest({version:10,id:1,request:{type:"abort"}})).toThrow();
});

it("does not compact a complete legacy image on the startup readiness path",async()=>{
  const f=await setup(),compact=vi.spyOn(f.roots,"compactImage");
  await f.native.handle({type:"prepare-native-image",reason:"first-install"},signal());
  expect(compact).not.toHaveBeenCalled();
});

it("lets foreground capture interrupt supervised automatic compaction",async()=>{
  const f=await setup();await f.capture(1);
  await f.selections.setSession({resume:ref(1).id,image:ref(8).id});
  const entered=Promise.withResolvers<AbortSignal>(),finish=Promise.withResolvers<undefined>();
  vi.spyOn(f.roots,"compactImage").mockImplementation(workSignal=>{entered.resolve(workSignal);workSignal.addEventListener("abort",()=>finish.resolve(undefined),{once:true});return finish.promise;});
  let completed=false;
  const preparing=f.native.handle({type:"prepare-native-image",reason:"automatic"},signal()).then(()=>{completed=true;});
  const workSignal=await entered.promise;
  try {
    await Promise.resolve();await Promise.resolve();
    expect(completed).toBe(false);
    await f.native.handle({type:"open-native-capture",snapshot:ref(2),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral"},signal());
    expect(workSignal.aborted).toBe(true);
    await preparing;expect(completed).toBe(true);
    await f.native.abort();
  }finally{finish.resolve(undefined);await preparing;}
});

it("aborts and drains optional compaction before storage disposal",async()=>{
  const f=await setup();await f.capture(1);await f.selections.setSession({resume:ref(1).id,image:ref(8).id});
  const entered=Promise.withResolvers<AbortSignal>(),finish=Promise.withResolvers<undefined>();
  vi.spyOn(f.roots,"compactImage").mockImplementation(workSignal=>{entered.resolve(workSignal);return finish.promise;});
  const preparing=f.native.handle({type:"prepare-native-image",reason:"automatic"},signal());
  const workSignal=await entered.promise;let retired=false;
  const disposing=f.native.abort().then(()=>{retired=true;});
  try {
    await Promise.resolve();expect(workSignal.aborted).toBe(true);expect(retired).toBe(false);
  }finally{finish.resolve(undefined);await Promise.all([preparing,disposing]);}
  expect(retired).toBe(true);
});

it("hashes a native incremental payload once for preflight and reuses that verified input for indexing",async()=>{
  const f=await setup(),payload=checkpointHeader("OXUP",16);
  await f.native.handle({type:"open-native-capture",snapshot:ref(1),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral"},signal());
  await f.native.handle({type:"seal-native-capture",capturedAtUnixMs:101,graphBytes:85,payloadBytes:payload.length},signal());
  await f.native.handle({type:"put-native-chunk",area:"graph",index:0,data:nativeGraphFixture()},signal());
  await f.native.handle({type:"put-native-chunk",area:"payloads",index:0,data:payload},signal());
  await f.native.handle({type:"commit-native-capture"},signal());
  const hashing=vi.spyOn(crypto.subtle,"digest");
  const leases:SnapshotReadLease[]=[];
  const open=f.objects.openVerifiedReads.bind(f.objects);
  vi.spyOn(f.objects,"openVerifiedReads").mockImplementation(async(...args)=>{const lease=await open(...args);leases.push(lease);return lease;});
  await f.native.handle({type:"open-native-capture",snapshot:ref(2),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral",baseline:ref(1)},signal());
  try {
    expect(hashing.mock.calls.filter(([,bytes])=>{
      if(bytes.byteLength!==16)return false;
      const view=bytes instanceof ArrayBuffer?new Uint8Array(bytes):new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      return new TextDecoder().decode(view.subarray(0,4))==="OXUP";
    })).toHaveLength(1);
    expect(leases).toHaveLength(1);
  }finally{await f.native.abort();}
  const saved=await f.catalog.load(ref(1).id);if(saved.schema!==4||saved.payloads.chunks[0]===undefined)throw new Error("Missing fixture payload");
  await expect(leases[0]?.read(saved.payloads.chunks[0])).rejects.toMatchObject({code:"ABORTED"});
});

async function setup() {
  const directory = new MemoryDirectory();
  const objects = await SnapshotObjects.open(directory);
  const catalog = new SnapshotCatalog(directory, objects);
  const recovery = new SnapshotCatalog(await directory.getDirectoryHandle("recovery", { create: true }), objects);
  const selectionBackend = opfsWorkspaceStoreBackend(new MemoryDirectory());
  const selections = new WorkspaceSelections(selectionBackend);
  const manifest = new Uint8Array([1]);
  const rootfs = { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256: ROOT, manifest: await objects.put(manifest) } as const;
  const pins = new Set<string>();
  const roots: NativeSnapshotEnvironment["rootfs"] = {
    currentCheckpointSource:()=>rootfs,
    prepareImage:(_owner,_signal,progress)=>{progress({completedObjects:1,completedBytes:3,totalBytes:3});return Promise.resolve();},
    compactImage:()=>Promise.resolve(),reclaimAccelerators:()=>Promise.resolve(),
    beginCheckpointVerification: () => Promise.resolve(() => {}),
    pinImage:owner=>{pins.add(owner.snapshotId);return Promise.resolve({rootfs,manifest});},
    captureCheckpoint: owner => { pins.add(owner.snapshotId); return Promise.resolve({ rootfs, manifest }); },
    acquireCheckpoint:owner=>{pins.add(owner.snapshotId);return Promise.resolve();},
    prepareCheckpoint: owner => { pins.add(owner.snapshotId); return Promise.resolve({id:"alpine",version:"v1",cpuProfile:"x86-64-v2",rootTreeSha256:ROOT,fileCount:0,totalBytes:0,metadata:new Uint8Array(),runtimes:{supportingFiles:[]}}); },
    releaseCheckpoint: owner => { pins.delete(owner.snapshotId); return Promise.resolve(); },
    currentRootfs:()=>({id:"alpine",version:"v1",cpuProfile:"x86-64-v2",rootTreeSha256:ROOT,fileCount:0,totalBytes:0,metadata:new Uint8Array(),runtimes:{supportingFiles:[]}}),
    activateCheckpoint:vi.fn<NativeSnapshotEnvironment["rootfs"]["activateCheckpoint"]>(()=>Promise.resolve({id:"alpine",version:"v1",cpuProfile:"x86-64-v2",rootTreeSha256:ROOT,fileCount:0,totalBytes:0,metadata:new Uint8Array(),runtimes:{supportingFiles:[]}})),
  };
  const native = new NativeSnapshotStore(objects, catalog, recovery, { rootfs: roots, selections, workspaceId: "test" });
  const write = (value: number) => new WorkspaceStore(selections.backend).commitStreams(BASE, {
    snapshot: workspaceBytesInput(new Uint8Array([value])), delta: workspaceBytesInput(new Uint8Array()),
  }, signal());
  const capture = async (id: number, hidden = false) => {
    await native.handle({ type: "open-native-capture", snapshot: ref(id), kind: hidden ? "safety" : "automatic",
      memoryBytes: 256 * 1024 ** 2, workspaceBaseSha256: BASE, rootPersistence: "ephemeral", recovery: hidden }, signal());
    await native.handle({ type: "seal-native-capture", capturedAtUnixMs: 100 + id, graphBytes: 85, payloadBytes: 1 }, signal());
    await native.handle({ type: "put-native-chunk", area: "graph", index: 0, data: nativeGraphFixture(1, id) }, signal());
    await native.handle({ type: "put-native-chunk", area: "payloads", index: 0, data: new Uint8Array([id + 10]) }, signal());
    return native.handle({ type: "commit-native-capture" }, signal());
  };
  const reopen = () => {
    const selections = new WorkspaceSelections(selectionBackend);
    return { native: new NativeSnapshotStore(objects, catalog, recovery, { rootfs: roots, selections, workspaceId: "test" }), selections };
  };
  return { native, objects, catalog, recovery, selections, write, capture, pins,roots, reopen, directory };
}

it("preflights shared selected and recovery chunks only once before native admission", async () => {
  const f = await setup(); await f.capture(1);
  const manifest = await f.catalog.load(ref(1).id);
  if (manifest.schema !== 4) throw new Error("wrong snapshot mode");
  const open=f.objects.openVerifiedReads.bind(f.objects);
  let lease:SnapshotReadLease|undefined;
  const acquire = vi.spyOn(f.objects, "openVerifiedReads").mockImplementation(async(...args)=>{lease=await open(...args);return lease;});
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), recovery: ref(1), rootPersistence: "ephemeral", destination }, signal());
  for (const chunk of [...manifest.graph.chunks, ...manifest.payloads.chunks]) {
    if (lease === undefined) throw new Error("missing verified source");
    expect(await lease.read(chunk)).toBeInstanceOf(Uint8Array);
  }
  expect(acquire).toHaveBeenCalledOnce();
  await f.native.abort();
});

it("inherits the previous checkpoint's complete image pin even before a native payload baseline exists",async()=>{
 const f=await setup();await f.capture(1);
 const saved=await f.catalog.load(ref(1).id);if(saved.schema!==4)throw new Error("wrong mode");
 const capture=vi.spyOn(f.roots,"captureCheckpoint");
 await f.native.handle({type:"open-native-capture",snapshot:ref(2),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral",parentId:ref(1).id},signal());
 expect(capture.mock.calls[0]?.[2]).toEqual({owner:{workspaceId:"test",snapshotId:ref(1).id},rootfs:saved.rootfs});
 await f.native.abort();
});

it("publishes an automatic restore directly when its durable workspace is already identical", async () => {
  const f = await setup(); await f.write(1); await f.capture(1);
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), recovery: ref(1), rootPersistence: "ephemeral", destination,
    replacedId: "22222222-2222-4333-8444-555555555555" }, signal());
  await f.native.handle({ type: "publish-native-restore" }, signal());
  await f.native.handle({ type: "complete-native-restore" }, signal());
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
});
it("failed_initial_runtime_publication_does_not_mark_rolled_back_files_completed",async()=>{
  const f=await setup();await f.write(1);await f.capture(1);
  const identity=decodeShippedInstallIdentity({mode:"userspace",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});
  const manifest=await f.catalog.load(ref(1).id);
  await f.catalog.commit({...manifest,kind:"shipped"},identity);
  await f.write(3);
  await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination,initialStart:identity},signal());
  await f.native.handle({type:"publish-native-restore"},signal());
  expect((await f.selections.initialStartEvidence()).initialStart).toEqual(identity);
  await f.native.abort();
  expect((await f.selections.initialStartEvidence()).initialStart).toBeUndefined();
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
});

it("overlaps independent checkpoint and image validation while holding the transaction busy", async () => {
  const f = await setup(); await f.capture(1);
  const preparing = vi.spyOn(f.roots, "prepareCheckpoint");
  vi.spyOn(f.objects, "verify").mockImplementationOnce(async () => {
    await Promise.resolve();
    expect(preparing).toHaveBeenCalledOnce();
    expect(f.native.busy).toBe(true);
  });
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), recovery: ref(1), rootPersistence: "ephemeral", destination }, signal());
  await f.native.abort();
});

it("keeps recovery checkpoints unlisted and commits files at one explicit publication boundary", async () => {
  const f = await setup();
  await f.write(1); await f.capture(1);
  await f.write(3); await f.capture(2, true);
  expect((await f.catalog.list()).map(entry => entry.id)).toEqual([ref(1).id]);
  expect((await f.recovery.list()).map(entry => entry.id)).toEqual([ref(2).id]);
  expect(await f.selections.session()).toEqual({ resume: ref(1).id, recovery: ref(2).id });
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), rootPersistence: "ephemeral", destination, recovery: ref(2) }, signal());
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
  expect(await f.selections.session()).toMatchObject({ recovery: ref(2).id });
  await f.native.handle({ type: "publish-native-restore" }, signal());
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  await f.native.handle({ type: "complete-native-restore" }, signal());
  await f.native.handle({ type: "retire-native-recovery", snapshot: ref(2) }, signal());
  expect(await f.recovery.list()).toEqual([]);
  const session=await f.selections.session();expect(session).toMatchObject({resume:ref(1).id});expect(session?.image).toMatch(/^[0-9a-f-]{36}$/u);
});

it("rolls files back after a failed runtime publication without releasing recovery objects", async () => {
  const f = await setup();
  await f.write(1); await f.capture(1);
  await f.write(3); await f.capture(2, true);
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), rootPersistence: "ephemeral", destination, recovery: ref(2) }, signal());
  await f.native.handle({ type: "publish-native-restore" }, signal());
  await f.native.abort();
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
  expect((await f.recovery.list()).map(entry => entry.id)).toEqual([ref(2).id]);
  const recovery = await f.recovery.load(ref(2).id);
  if (recovery.schema !== 4) throw new Error("wrong recovery mode");
  expect(await f.native.objectRefs()).toContain(recovery.graph.chunks[0]?.sha256);
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(2), rootPersistence: "ephemeral", destination, recovery: ref(2) }, signal());
  await f.native.handle({ type: "publish-native-restore" }, signal());
  await f.native.handle({ type: "complete-native-restore" }, signal());
  expect((await f.native.recoveryCandidate())?.id).toBe(ref(2).id);
  await f.native.collect(new Set([ref(1).id]));
  expect((await f.native.recoveryCandidate())?.id).toBe(ref(2).id);
});

it("keeps a selected hidden startup source reachable through interrupted preparation and retains newer files", async () => {
  const f = await setup();
  await f.write(1); await f.capture(1);
  await f.write(3); await f.capture(2, true);
  await f.write(4);
  await f.native.handle({ type: "prepare-native-restore", snapshot: ref(2), rootPersistence: "ephemeral", destination, recovery: ref(2), replacedId: ref(3).id }, signal());
  const { native: reopened, selections } = f.reopen(); // A page termination runs neither abort nor publication.
  await reopened.collect(new Set([ref(1).id]));
  expect((await reopened.recoveryCandidate())?.id).toBe(ref(2).id);
  expect(await new WorkspaceStore(selections.backend).read(BASE)).toEqual(new Uint8Array([4]));
  const prepared = await reopened.handle({ type: "prepare-native-restore", snapshot: ref(2), rootPersistence: "ephemeral", destination, recovery: ref(2), replacedId: ref(4).id }, signal());
  expect(prepared).toMatchObject({ manifest: ref(2), newerFiles: { workspace: true } });
  const retained = await selections.retainedWorkspace(ref(4).id, signal(), BASE);
  if (retained?.snapshot === undefined) throw new Error("Newer pre-resume workspace was not retained");
  const stream = retained.snapshot.source(signal());
  try { for await (const bytes of stream.frames) expect(bytes).toEqual(new Uint8Array([4])); }
  finally { await stream.retire(); await retained.retire(); }
  await reopened.abort();
  expect((await reopened.recoveryCandidate())?.id).toBe(ref(2).id);
  expect(await new WorkspaceStore(selections.backend).read(BASE)).toEqual(new Uint8Array([4]));
});

it("rejects corrupt bytes before changing selected files or beginning replacement", async () => {
  const f = await setup();
  await f.write(1); await f.capture(1);
  await f.write(3);
  const saved = await f.catalog.load(ref(1).id);
  if (saved.schema !== 4 || saved.payloads.chunks[0] === undefined) throw new Error("missing native fixture");
  await f.objects.remove(saved.payloads.chunks[0].sha256);
  await expect(f.native.handle({ type: "prepare-native-restore", snapshot: ref(1), rootPersistence: "ephemeral", destination }, signal())).rejects.toThrow();
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
  expect(f.native.busy).toBe(false);
});

it("routes precopy rounds through the validated channel and publishes only the final live payloads", async () => {
  const f = await setup();
  const send = (request: unknown) => {
    const envelope = decodeSnapshotStorageRequest({ version: SNAPSHOT_CHANNEL_VERSION, id: 1, request });
    if (envelope.request.type === "native-payload-round-open" || envelope.request.type === "native-payload-round-put"
      || envelope.request.type === "native-payload-round-seal" || envelope.request.type === "native-live-index-put"
      || envelope.request.type === "native-live-index-seal" || envelope.request.type === "native-payload-consolidate") {
      return f.native.handle(envelope.request, signal());
    }
    throw new Error("wrong precopy request");
  };
  await f.native.handle({ type: "open-native-capture", snapshot: ref(1), kind: "automatic", memoryBytes: 256 * 1024 ** 2,
    workspaceBaseSha256: BASE, rootPersistence: "ephemeral" }, signal());
  const declaration = encodeCheckpointDeclaration({ reference: 1n, kind: 0n, length: 1n });
  for (const round of [0, 1]) {
    const bytes = new Uint8Array(41); bytes.set(checkpointHeader("OXUP", 16));
    new DataView(bytes.buffer).setBigUint64(8, 1n, true); bytes.set(declaration, 16); bytes[40] = round + 1;
    await send({ type: "native-payload-round-open", round });
    await send({ type: "native-payload-round-put", round, index: 0, data: bytes });
    await send({ type: "native-payload-round-seal", round, bytes: bytes.length });
  }
  const live = new Uint8Array(40); live.set(checkpointHeader("OXUD", 16));
  new DataView(live.buffer).setBigUint64(8, 1n, true); live.set(declaration, 16);
  await send({ type: "native-live-index-put", index: 0, data: live });
  await send({ type: "native-live-index-seal", bytes: live.length });
  expect(await send({ type: "native-payload-consolidate" })).toBe(41);
  await f.native.handle({ type: "seal-native-capture", capturedAtUnixMs: 101, graphBytes: 85, payloadBytes: 41 }, signal());
  await f.native.handle({ type: "put-native-chunk", area: "graph", index: 0, data: nativeGraphFixture() }, signal());
  await f.native.handle({ type: "commit-native-capture" }, signal());
  const saved = await f.catalog.load(ref(1).id);
  if (saved.schema !== 4 || saved.payloads.chunks[0] === undefined) throw new Error("missing native fixture");
  expect((await f.objects.read(saved.payloads.chunks[0])).at(-1)).toBe(2);
});

it("rolls file selection and verified image source back when activation fails",async()=>{
 const f=await setup();await f.write(1);await f.capture(1);await f.write(3);await f.capture(2,true);
 const activation=vi.spyOn(f.roots,"activateCheckpoint");activation.mockRejectedValueOnce(new Error("source activation failed"));
 await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination,recovery:ref(2)},signal());
 await expect(f.native.handle({type:"publish-native-restore"},signal())).rejects.toThrow("source activation failed");
 await f.native.abort();expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
 expect(activation).toHaveBeenCalledTimes(2);expect(activation.mock.calls[1]?.[0].snapshotId).not.toBe(ref(1).id);
 expect(await f.selections.session()).toMatchObject({resume:ref(1).id,recovery:ref(2).id});
});

it("pins a valid incremental baseline through capture and reports a retired baseline for full retry",async()=>{
 const f=await setup(),payload=checkpointHeader("OXUP",16);
 await f.native.handle({type:"open-native-capture",snapshot:ref(1),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral"},signal());
 await f.native.handle({type:"seal-native-capture",capturedAtUnixMs:101,graphBytes:85,payloadBytes:payload.length},signal());
 await f.native.handle({type:"put-native-chunk",area:"graph",index:0,data:nativeGraphFixture()},signal());
 await f.native.handle({type:"put-native-chunk",area:"payloads",index:0,data:payload},signal());
 await f.native.handle({type:"commit-native-capture"},signal());
 let reading=0,peak=0;
 const objects=f.directory.directory("objects",false);
 for(const name of objects.names()){
  const file=objects.file(name,false),read=file.getFile.bind(file);
  vi.spyOn(file,"getFile").mockImplementation(async()=>{reading++;peak=Math.max(peak,reading);try{await Promise.resolve();return await read();}finally{reading--;}});
 }
 await f.native.handle({type:"open-native-capture",snapshot:ref(2),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral",baseline:ref(1)},signal());
 expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(8);
 expect(await f.native.protectedIds()).toContain(ref(1).id);
 const saved=await f.catalog.load(ref(1).id);if(saved.schema!==4)throw new Error("wrong mode");
 expect(await f.native.objectRefs()).toContain(saved.payloads.chunks[0]?.sha256);await f.native.abort();
 await f.catalog.delete(ref(1).id);
 await expect(f.native.handle({type:"open-native-capture",snapshot:ref(3),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral",baseline:ref(1)},signal())).rejects.toMatchObject({code:"STORAGE_NOT_FOUND",detail:{reason:"checkpoint-baseline-unavailable"}});
 expect(f.native.busy).toBe(false);expect(f.pins).not.toContain(ref(3).id);
});

it("preserves cancellation while validating an incremental baseline and releases its new pin",async()=>{
 const f=await setup();await f.capture(1);
 const saved=await f.catalog.load(ref(1).id);if(saved.schema!==4)throw new Error("wrong mode");
 const graph=saved.graph.chunks[0];if(graph===undefined)throw new Error("Missing graph fixture");
 const file=f.directory.directory("objects",false).file(graph.sha256,false),read=file.getFile.bind(file),controller=new AbortController();
 vi.spyOn(file,"getFile").mockImplementation(()=>{controller.abort();return read();});
 await expect(f.native.handle({type:"open-native-capture",snapshot:ref(2),kind:"automatic",memoryBytes:256*1024**2,workspaceBaseSha256:BASE,rootPersistence:"ephemeral",baseline:ref(1)},controller.signal)).rejects.toMatchObject({code:"ABORTED"});
 expect(f.native.busy).toBe(false);expect(f.pins).not.toContain(ref(2).id);
});

it("keeps a published restore successful when reclaiming old pins fails",async()=>{
 const f=await setup();await f.write(1);await f.capture(1);await f.write(2);
 await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination},signal());
 await f.native.handle({type:"publish-native-restore"},signal());
 vi.spyOn(f.roots,"releaseCheckpoint").mockRejectedValue(new Error("cleanup interrupted"));
 await expect(f.native.handle({type:"complete-native-restore"},signal())).resolves.toBeUndefined();
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
 expect(f.native.busy).toBe(false);
});

it("selects cold files without fetching the entire immutable rootfs closure",async()=>{
 const f=await setup();vi.spyOn(f.roots,"captureCheckpoint").mockRejectedValue(new Error("cold boot attempted a full offline capture"));
 const selected=await f.native.selectFiles({boot:"live",rootTreeSha256:ROOT,rootPersistence:"ephemeral"},signal());expect(selected.sourceId).toMatch(/^[0-9a-f-]{36}$/u);
 expect((await f.selections.session())?.image).toMatch(/^[0-9a-f-]{36}$/u);
});


it("stages automatic reconciliation through bounded leases before the atomic restart-visible outcome",async()=>{
 const f=await setup();await f.write(1);await f.capture(1);await f.write(3);
 const before="22222222-2222-4333-8444-555555555555";
 await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination,replacedId:before},signal());
 await expect(f.native.handle({type:"publish-native-restore"},signal())).rejects.toThrow("not durably staged");
 const binding={session:"33333333-2222-4333-8444-555555555555",generation:1},traffic=new AssistanceTraffic(7),credit=traffic.grant({...binding,producer:"storage",process:null,pool:"data",bytes:WORKSPACE_PUBLICATION_BYTES,entries:1});
 const snapshot=transferWorkspaceStream(workspaceBytesInput(new Uint8Array([9])),binding,1,traffic),delta=transferWorkspaceStream(workspaceBytesInput(new Uint8Array()),binding,2,traffic);
 const result=decodeWorkspacePublicationResult(await f.native.handle({type:"stage-native-workspace",publication:{workspaceBaseSha256:BASE,credit,snapshot:snapshot.descriptor,delta:delta.descriptor},preservedId:before},signal()));
 expect(result).toMatchObject({retired:true,outcome:{kind:"committed"}});if(!result.retired)throw new Error("missing retirement");traffic.returnCredit(result.credit);await Promise.all([snapshot.finished,delta.finished]);expect(traffic.pendingBytes).toBe(0);
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
 await f.native.handle({type:"publish-native-restore"},signal());await f.native.handle({type:"complete-native-restore"},signal());
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([9]));expect(await f.selections.isPreserved(before)).toBe(true);
 // A later explicit restore must still select the immutable original checkpoint streams.
 await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination},signal());await f.native.handle({type:"publish-native-restore"},signal());await f.native.handle({type:"complete-native-restore"},signal());
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
});

for(const empty of [false,true])it(`leases an imported ${empty?"empty":"saved"} ancestor from its unpublished file selection and retires failed preparation`,async()=>{
 const f=await setup();if(!empty)await f.write(1);await f.capture(1);
 // Portable imports retain the catalog and its streams, but have no browser-local file pin.
 await f.selections.release(ref(1).id);await f.write(3);
 const original="22222222-2222-4333-8444-555555555555";
 await f.native.handle({type:"prepare-native-restore",snapshot:ref(1),rootPersistence:"ephemeral",destination,replacedId:original},signal());
 const ancestor=f.native.retainedReadId(ref(1).id);
 expect(ancestor).not.toBe(ref(1).id);expect(f.native.retainedReadId(original)).toBe(original);
 expect(f.native.retainedReadId(ref(9).id)).toBe(ref(9).id);
 const lease=await f.selections.retainedWorkspace(ancestor,signal(),BASE);
 if(empty)expect(lease).toBeUndefined();else {expect(lease?.snapshot).toBeDefined();await lease?.retire();}
 await f.native.collect(new Set([ref(1).id]));expect(await f.selections.has(ancestor)).toBe(true);
 await f.native.abort();expect(f.native.retainedReadId(ref(1).id)).toBe(ref(1).id);
 expect(await f.selections.has(ancestor)).toBe(false);expect(await f.selections.has(original)).toBe(false);
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([3]));
 expect(await f.catalog.exists(ref(1).id)).toBe(true);
});

it("forwards only increasing capture progress while image preparation repeats object counts", async () => {
  const f = await setup();
  // Preparation reports bytes and stage changes with an unchanged object count; the capture
  // channel's client rejects any repeated count as stale.
  vi.spyOn(f.roots, "captureCheckpoint").mockImplementation((owner, progress) => {
    for (const completed of [1, 1, 3, 3, 3, 5]) progress?.(completed);
    f.pins.add(owner.snapshotId);
    return Promise.resolve({ rootfs: f.roots.currentCheckpointSource(), manifest: new Uint8Array([1]) });
  });
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => (now += 2_000));
  const forwarded: number[] = [];
  try {
    await f.native.handle({ type: "open-native-capture", snapshot: ref(1), kind: "automatic", memoryBytes: 256 * 1024 ** 2,
      workspaceBaseSha256: BASE, rootPersistence: "ephemeral", recovery: false }, signal(),
    value => { if (typeof value === "number") forwarded.push(value); });
    expect(forwarded).toEqual([1, 3, 5]);
  } finally { vi.restoreAllMocks(); await f.native.abort(); }
});
