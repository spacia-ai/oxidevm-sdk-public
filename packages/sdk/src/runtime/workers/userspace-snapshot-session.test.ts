import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import { receiveWorkspaceStream } from "./workspace-transfer.js";
import { expect, it, vi } from "vitest";
import { serveRestoreStream } from "./snapshot-restore-stream.js";
import { UserspaceSnapshotSession, type NativeSnapshotRuntime } from "./userspace-snapshot-session.js";
import { VMError } from "../errors.js";
import type { SnapshotStorageClient, SnapshotStorageRequest } from "./snapshot-channel.js";
import type { UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import type { SnapshotEventRecord } from "../protocol/snapshots.js";
import { encodeNativeAttachments, type NativeAttachments } from "./userspace-attachments.js";
import type { CheckpointInput, CheckpointSink } from "./userspace-checkpoint.js";

const snapshot = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-13T10:00:00.000Z" };
const HASH = "a".repeat(64);
const attachment = encodeNativeAttachments({ nextKey: 1, processes: [] });
const manifest: UserspaceSnapshotManifest = { schema: 4, mode: "userspace", ...snapshot, kind: "named", parent: null, capturedAtUnixMs: 1,
  compatibility: { format: "OXUC", version: 1, abiVersion: 37, memoryBytes: 256 * 1024 ** 2 },
  graph: { bytes: 1, chunks: [{ index: 0, bytes: 1, sha256: HASH }] }, payloads: { bytes: 0, chunks: [] },
  rootfs: { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256: HASH, manifest: { bytes: 1, sha256: HASH } } };

function setup(workspaceBaseSha256?: string) {
  const order: string[] = [];
  const requests: SnapshotStorageRequest[] = [];
  let storageFailure: SnapshotStorageRequest["type"] | undefined;
  let restoreFailure = false, destructive = false;
  let captureFinish = false;
  let newerFiles={workspace:false,root:false};
  const capture = { transfer: async (sink: CheckpointSink) => {
    await sink("graph", 0, new Uint8Array([1])); return { graphBytes: 1, payloadBytes: 0 };
  }, finish: (committed: boolean) => { captureFinish = committed; order.push(`capture-finish:${String(committed)}`); }, abort: () => { order.push("capture-abort"); } };
  const restored = () => ({
    exportWorkspace: () => ({snapshot:workspaceBytesInput(new Uint8Array(12)),delta:workspaceBytesInput(new Uint8Array(12)),complete:(committed:boolean)=>{order.push(`workspace-complete:${String(committed)}`);}}),
    discardStartup: () => {order.push("candidate-discard");},
    prepare: () => { order.push("candidate-prepare"); },
    beginReconcile: () => {throw new Error("native reconciliation is supplied by the host seam");},
    validateAttachment: () => undefined,
    get recoveryRequired() { return destructive; },
    read: async (graph: CheckpointInput, payloads: CheckpointInput) => {
      for await (const chunk of graph.frames) expect(chunk).toEqual(new Uint8Array([1]));
      await graph.retire(); await payloads.retire(); destructive = true;
      if (restoreFailure) { restoreFailure = false; throw new VMError("STORAGE_ERROR", "injected payload failure"); }
      order.push("runtime-ready");
    }, complete: () => { order.push("runtime-publish"); destructive = false; }, abort: () => { order.push("restore-abort"); },
  });
  const host: NativeSnapshotRuntime = {
    memoryBytes: 256 * 1024 ** 2, rootPersistence: "ephemeral", workspaceBaseSha256: workspaceBaseSha256 ?? HASH, image: HASH,
    destination: { manifestUrl: "https://example.com/rootfs.json", trusted: { keyId: "test", publicKey: new Uint8Array(32) } },
    dirty: () => true, get baseline() { return 9n; },
    assertCheckpointAdmission: () => undefined,
    freeze: () => { order.push("freeze"); return Promise.resolve(); }, resume: () => { order.push("resume"); },
    attachments: () => attachment, beginCapture: () => capture,
    beginPrecopy: () => {
      let round = 0;
      return { ...capture, transferRound: async () => { await Promise.resolve(); order.push("running-round"); return { round, payloadBytes: 16 }; },
        commitRound: () => { round++; }, finalize: async (sink: CheckpointSink) => {
          await sink("graph", 0, new Uint8Array([1])); return { round, graphBytes: 1, payloadBytes: 16, liveIndexBytes: 16 };
        } };
    },
    beginRestore: () => { order.push("restore-begin"); return restored(); },
    beginRecovery: () => { order.push("recovery-begin"); return restored(); },
    discardStartup: async candidate => {candidate?.discardStartup();order.push("startup-discard");await Promise.resolve();},
    reconcile: async () => { await Promise.resolve(); order.push("workspace-reconcile"); return { workspace:{workspace:"conflict-preserved",unresolved:["/workspace/a"]},workspaceDetails:{state:"conflict-preserved",conflicts:[{path:"/workspace/a",reason:"changed-in-both"}],omittedConflicts:0} }; },
    prepareAttachments: (state, recovering) => { order.push(`attachments:${String(recovering)}`); return { attachments: state, publish: () => { order.push("attachments-publish"); } }; },
  };
  let selected = snapshot;
  const storage: Pick<SnapshotStorageClient, "request"> = { request: async request => {
    await Promise.resolve();
    requests.push(request);
    order.push(request.type);
    if(request.type === "stage-native-workspace") {
      const publication=request.publication;
      for(const descriptor of workspacePublicationTransfers(publication)) {
        const producer=receiveWorkspaceStream(descriptor,descriptor.binding,descriptor.transfer).source(new AbortController().signal);
        for await(const frame of producer.frames) expect(frame.length).toBe(12);
        await producer.retire();
      }
      const failed=storageFailure===request.type; if(failed)storageFailure=undefined;
      return {retired:true,credit:{...publication.credit,kind:"return"},outcome:failed?{kind:"failed",error:{code:"QUOTA_EXCEEDED",message:"injected storage failure"}}:{kind:"committed",generation:1}};
    }
    if (request.type === storageFailure) { storageFailure = undefined; throw new VMError("QUOTA_EXCEEDED", "injected storage failure"); }
    if (request.type === "open-native-capture") { selected = request.snapshot; return undefined; }
    if (request.type === "commit-native-capture") return selected;
    if (request.type === "prepare-native-restore") return { manifest: { ...manifest, ...request.snapshot }, attachment,newerFiles,
      rootfs: { id: "alpine", version: "v1", rootTreeSha256: HASH, ...(workspaceBaseSha256 === undefined ? {} : { workspaceBaseSha256 }), cpuProfile: "x86-64-v2", fileCount: 0, totalBytes: 0, metadata: new Uint8Array(4), runtimes: { supportingFiles: [] } } };
    if (request.type === "stream-native-restore") return serveRestoreStream(request.port,
      request.area === "graph" ? [{area:"native-graph",index:0,read:()=>Promise.resolve(Uint8Array.of(1))}] : [], new AbortController().signal);
    if (request.type === "read-native-restore") return new Uint8Array([1]);
    if (request.type === "native-payload-consolidate") return 16;
    return undefined;
  } };
  const events: SnapshotEventRecord[] = [];
  return { setFileDifferences:(value:typeof newerFiles)=>{newerFiles=value;}, order, requests, host, events, session: new UserspaceSnapshotSession(host, storage, event => events.push(event)), failStorage: (type: SnapshotStorageRequest["type"]) => { storageFailure = type; },
    failRestore: () => { restoreFailure = true; }, captureCommitted: () => captureFinish };
}

it("rejects active browser work before opening or preparing a capture", async () => {
  const f = setup();
  f.host.assertCheckpointAdmission = () => {
    throw new VMError("FEATURE_NOT_AVAILABLE", "Active browser process", { reason: "command-interceptor-active" });
  };
  await expect(f.session.capture({ kind: "named" })).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE", detail: { reason: "command-interceptor-active" },
  });
  expect(f.requests).toEqual([]);
  expect(f.order).toEqual([]);
});

it("resumes unchanged durable files without replaying or rewriting the workspace", async () => {
  const f = setup();
  const result = await f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" });
  expect(f.order).not.toContain("workspace-reconcile");
  expect(f.order).not.toContain("stage-native-workspace");
  expect(f.order.indexOf("publish-native-restore")).toBeLessThan(f.order.indexOf("runtime-publish"));
  expect(result.newerFilesDropped).toBe(false);
});

it("acknowledges dirty state only after storage commits and resumes after failed saves", async () => {
  const f = setup(); f.failStorage("commit-native-capture");
  await expect(f.session.capture({ kind: "named" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(f.captureCommitted()).toBe(false); expect(f.order.at(-1)).toBe("resume");
  f.order.length = 0;
  await f.session.capture({ kind: "named" });
  expect(f.order.indexOf("commit-native-capture")).toBeLessThan(f.order.indexOf("capture-finish:true"));
  expect(f.captureCommitted()).toBe(true);
});

it("recovers the original runtime and host handles when replacement fails after retiring its heap", async () => {
  const f = setup(); f.failRestore();
  await expect(f.session.restore(snapshot)).rejects.toThrow("injected payload failure");
  expect(f.order).toContain("recovery-begin"); expect(f.order).toContain("attachments:true");
  expect(f.order.indexOf("publish-native-restore")).toBeLessThan(f.order.indexOf("runtime-publish"));
  expect(f.order.at(-1)).toBe("resume");
});

it("leaves the live session intact if recovery storage cannot be prepared", async () => {
  const f = setup(); f.failStorage("open-native-capture");
  await expect(f.session.restore(snapshot)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(f.order).not.toContain("restore-begin"); expect(f.order.at(-1)).toBe("resume");
});

it("reports a committed restore even if cancellation arrives with the publication acknowledgement", async () => {
  const f = setup(), abort = new AbortController();
  const prepare = f.host.prepareAttachments.bind(f.host);
  vi.spyOn(f.host, "prepareAttachments").mockImplementation((state, recovering, candidate, image) => {
    const prepared = prepare(state, recovering, candidate, image); return { ...prepared, publish: () => { prepared.publish(); abort.abort(); } };
  });
  await expect(f.session.restore(snapshot, { signal: abort.signal })).resolves.toMatchObject({ processes: [] });
  expect(f.order).not.toContain("recovery-begin");
});

it("returns newly allocated attachment keys and saves running rounds before the final freeze", async () => {
  const f = setup();
  await f.session.capture({ kind: "named" });
  expect(f.order.filter(item => item === "running-round")).toHaveLength(3);
  expect(f.order.indexOf("running-round")).toBeLessThan(f.order.indexOf("freeze"));
  const attachments: NativeAttachments = { nextKey: 31, processes: [{ key: 30, identityKey: 12, pid: 7, command: "sh", terminal: undefined,
    stdinOpen: true, sequence: 0, acknowledged: 0, tail: new Uint8Array() }] };
  vi.spyOn(f.host, "prepareAttachments").mockReturnValue({ attachments, publish: () => {} });
  await expect(f.session.restore(snapshot)).resolves.toMatchObject({ processes: [{ mode: "userspace", attachmentKey: 30, pid: 7 }] });
});

it("discards a failed precopy registrar and retries with an entirely fresh frozen capture", async () => {
  const f = setup();
  vi.spyOn(f.host, "beginPrecopy").mockImplementationOnce(() => { throw new VMError("STORAGE_ERROR", "lost precopy registrar", { discardRounds: true }); });
  await f.session.capture({ kind: "named" });
  expect(f.order.filter(item => item === "open-native-capture")).toHaveLength(2);
  expect(f.order.indexOf("abort")).toBeLessThan(f.order.lastIndexOf("open-native-capture"));
  expect(f.captureCommitted()).toBe(true);
});

it("captures again after a held workspace publication and includes its barrier in the frozen pause", async () => {
  const f = setup();
  await f.session.capture({ kind: "named" });
  const publication = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>();
  vi.spyOn(f.host, "beginPrecopy").mockImplementationOnce(() => {
    throw new VMError("PROTOCOL_ERROR", "workspace publication active", {
      reason: "checkpoint-begin-rejected", phase: "initial-round", domain: "runtime", owner: "workspace",
      nativeReason: 1, scalar0: 0, scalar1: 0, discardRounds: true,
    });
  });
  vi.spyOn(f.host, "freeze").mockImplementationOnce(async () => {
    f.order.push("publication-barrier"); entered.resolve(undefined);
    await publication.promise; f.order.push("publication-committed");
  });
  const capture = f.host.beginCapture.bind(f.host);
  vi.spyOn(f.host, "beginCapture").mockImplementation(() => { f.order.push("frozen-capture"); return capture(); });
  let clock = 10;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const pending = f.session.capture({ kind: "named" });
    await entered.promise;
    expect(f.order.filter(item => item === "commit-native-capture")).toHaveLength(1);
    expect(f.order).not.toContain("frozen-capture");
    clock = 80; publication.resolve(undefined);
    const saved = await pending;
    expect(saved.pauseMilliseconds).toBe(70);
    expect(f.order.indexOf("publication-committed")).toBeLessThan(f.order.indexOf("frozen-capture"));
    expect(f.order.filter(item => item === "commit-native-capture")).toHaveLength(2);
    expect(f.order.filter(item => item === "open-native-capture")).toHaveLength(3);
    expect(f.captureCommitted()).toBe(true);
  } finally { now.mockRestore(); publication.resolve(undefined); }
});

it("cancels a pending publication fallback without committing a capture and permits later retry", async () => {
  const f = setup(), controller = new AbortController();
  const publication = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>();
  vi.spyOn(f.host, "beginPrecopy").mockImplementationOnce(() => {
    throw new VMError("PROTOCOL_ERROR", "workspace publication active", { discardRounds: true });
  });
  vi.spyOn(f.host, "freeze").mockImplementationOnce(async () => {
    entered.resolve(undefined); await publication.promise;
  });
  const pending = f.session.capture({ kind: "named", signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await entered.promise; controller.abort(); publication.resolve(undefined); await rejected;
  expect(f.order).not.toContain("commit-native-capture");
  expect(f.order).toContain("resume");
  await f.session.capture({ kind: "named" });
  expect(f.order.filter(item => item === "commit-native-capture")).toHaveLength(1);
});

it("keeps a published restore committed when temporary recovery-pin retirement fails", async () => {
  const f = setup(); f.failStorage("retire-native-recovery");
  await expect(f.session.restore(snapshot)).resolves.toMatchObject({ processes: [] });
  expect(f.order).not.toContain("recovery-begin");
  expect(f.events).toEqual([{ type: "restore-progress", completedBytes: 0, totalBytes: 1 }, { type: "restore-progress", completedBytes: 1, totalBytes: 1 }]);
});

it("pairs incremental capture only with the exact native token of a committed baseline", async () => {
  const f = setup(), begin = vi.spyOn(f.host, "beginPrecopy");
  const first = await f.session.capture({ kind: "automatic" });
  await f.session.capture({ kind: "automatic" });
  expect(f.requests.filter(request => request.type === "open-native-capture")).toMatchObject([
    { type: "open-native-capture" }, { baseline: first.snapshot },
  ]);
  expect(begin.mock.calls).toEqual([[undefined], [9n]]);
  vi.spyOn(f.host, "baseline", "get").mockReturnValue(0n);
  await f.session.capture({ kind: "automatic" });
  expect(f.requests.filter(request => request.type === "open-native-capture").at(-1)).not.toHaveProperty("baseline");
});


it("reconciles automatic startup before attachment and durable publication", async () => {
  const f=setup();
  f.setFileDifferences({workspace:true,root:false});
  const result=await f.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"});
  expect(f.order.indexOf("candidate-prepare")).toBeLessThan(f.order.indexOf("workspace-reconcile"));
  expect(f.order.indexOf("workspace-reconcile")).toBeLessThan(f.order.indexOf("attachments:false"));
  expect(f.order.indexOf("workspace-reconcile")).toBeLessThan(f.order.indexOf("publish-native-restore"));
  expect(result).toMatchObject({workspace:{workspace:"conflict-preserved",unresolved:["/workspace/a"]},newerFilesDropped:false});
});
it("retains the selected startup source instead of replacing it with an empty-runtime recovery", async () => {
  const f = setup();
  await f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" });
  expect(f.order).not.toContain("open-native-capture");
  expect(f.requests.filter(request => request.type === "prepare-native-restore")).toMatchObject([
    { snapshot, recovery: snapshot },
  ]);
  expect(f.order).not.toContain("retire-native-recovery");
});
it("discards an unpublished startup candidate instead of publishing its saved processes on failure", async () => {
  const f = setup(); f.failRestore();
  await expect(f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" })).rejects.toThrow("injected payload failure");
  expect(f.order).not.toContain("open-native-capture");
  expect(f.requests.filter(request => request.type === "prepare-native-restore")).toMatchObject([
    { snapshot, recovery: snapshot },
  ]);
  expect(f.order).not.toContain("recovery-begin");
  expect(f.order).toContain("startup-discard");
  expect(f.order).not.toContain("runtime-publish");
  expect(f.order.at(-1)).toBe("resume");
});
it("leaves the committed startup source selected when metadata preparation fails before destruction", async () => {
  const f = setup(); f.failStorage("prepare-native-restore");
  await expect(f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(f.order).not.toContain("open-native-capture");
  expect(f.order).not.toContain("restore-begin");
  expect(f.order).not.toContain("recovery-begin");
  expect(f.order).toContain("abort");
  expect(f.order.at(-1)).toBe("resume");
});
it("captures independent rollback state for an explicit restore before any prior save", async () => {
  const f = setup();
  await f.session.restore(snapshot);
  expect(f.order).toContain("open-native-capture");
  const prepared = f.requests.find(request => request.type === "prepare-native-restore");
  if (prepared?.type !== "prepare-native-restore") throw new Error("Missing explicit native preparation");
  expect(prepared.recovery).toBeDefined();
  expect(prepared.recovery).not.toEqual(snapshot);
});
it("captures newer live rollback state after a first automatic restore has committed", async () => {
  const f = setup();
  await f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" });
  f.order.length = 0;
  await f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" });
  expect(f.order).toContain("open-native-capture");
  const prepared = f.requests.filter(request => request.type === "prepare-native-restore").at(-1);
  if (prepared?.type !== "prepare-native-restore") throw new Error("Missing live native preparation");
  expect(prepared.recovery).not.toEqual(snapshot);
});
it("recovers after reconciliation fails and bypasses it for explicit restores",async()=>{
  const f=setup();f.setFileDifferences({workspace:true,root:false});vi.spyOn(f.host,"reconcile").mockRejectedValueOnce(new Error("replay digest mismatch"));
  await expect(f.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"})).rejects.toThrow("replay digest mismatch");
  expect(f.order).toContain("startup-discard");expect(f.order).not.toContain("recovery-begin");
  f.order.length=0;await f.session.restore(snapshot);expect(f.order).not.toContain("workspace-reconcile");
});

it("recovers when cancellation arrives during automatic reconciliation before publication",async()=>{
  const f=setup(), abort=new AbortController();
  f.setFileDifferences({workspace:true,root:false});
  vi.spyOn(f.host,"reconcile").mockImplementation(async()=>{await Promise.resolve();abort.abort();throw new VMError("ABORTED","cancelled reconciliation");});
  await expect(f.session.restore(snapshot,{signal:abort.signal,replacedId:"123e4567-e89b-42d3-a456-426614174002"})).rejects.toMatchObject({code:"ABORTED"});
  expect(f.order).toContain("startup-discard");expect(f.order).not.toContain("recovery-begin");expect(f.order).not.toContain("attachments:false");expect(f.order.at(-1)).toBe("resume");
});


it("reports actual durable file rollback and excludes the workspace carried forward on startup",async()=>{
  const explicit=setup();explicit.setFileDifferences({workspace:true,root:false});
  expect((await explicit.session.restore(snapshot)).newerFilesDropped).toBe(true);
  const automatic=setup();automatic.setFileDifferences({workspace:true,root:false});
  expect((await automatic.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"})).newerFilesDropped).toBe(false);
  automatic.setFileDifferences({workspace:true,root:true});
  expect((await automatic.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"})).newerFilesDropped).toBe(true);
});

it("returns the selected verified rootfs with the committed restore result", async () => {
  const f = setup();
  const restored = await f.session.restore(snapshot);
  expect(restored).toMatchObject({ nativeRootfs: {
    id: "alpine", version: "v1", rootTreeSha256: HASH, metadata: new Uint8Array(4),
  } });
});

it("stages reconciled workspace before atomic selection and acknowledges native durability afterwards",async()=>{
  const f=setup();
  f.setFileDifferences({workspace:true,root:false});
  await f.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"});
  const stage=f.order.indexOf("stage-native-workspace"), publish=f.order.indexOf("publish-native-restore"), ack=f.order.indexOf("workspace-complete:true");
  expect(stage).toBeGreaterThan(f.order.indexOf("workspace-reconcile"));
  expect(stage).toBeLessThan(f.order.indexOf("attachments:false"));
  expect(publish).toBeGreaterThan(stage);expect(ack).toBeGreaterThan(publish);
  expect(f.order.indexOf("runtime-publish")).toBeGreaterThan(ack);
});
it("failed reconciled workspace staging never acknowledges native durability and discards the startup candidate",async()=>{
  const f=setup();f.setFileDifferences({workspace:true,root:false});f.failStorage("stage-native-workspace");
  await expect(f.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"})).rejects.toMatchObject({code:"QUOTA_EXCEEDED"});
  expect(f.order).not.toContain("workspace-complete:true");
  expect(f.order).toContain("workspace-complete:false");expect(f.order).toContain("startup-discard");
});

it("a failed atomic selection discards staged workspace without a native durability acknowledgement",async()=>{
  const f=setup();f.setFileDifferences({workspace:true,root:false});f.failStorage("publish-native-restore");
  await expect(f.session.restore(snapshot,{replacedId:"123e4567-e89b-42d3-a456-426614174002"})).rejects.toMatchObject({code:"QUOTA_EXCEEDED"});
  expect(f.order).toContain("stage-native-workspace");
  expect(f.order).not.toContain("workspace-complete:true");
  expect(f.order).toContain("workspace-complete:false");
  expect(f.order).toContain("startup-discard");
});


it("uses the verified distinct workspace base when unchanged files bypass reconciliation", async () => {
  const base = "b".repeat(64), f = setup(base);
  const reconcile = vi.spyOn(f.host, "reconcile"), attachments = vi.spyOn(f.host, "prepareAttachments");
  await f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" });
  expect(reconcile).not.toHaveBeenCalled();
  expect(f.requests.some(request => request.type === "stage-native-workspace")).toBe(false);
  expect(attachments.mock.calls[0]?.[3]).toEqual({ rootTreeSha256: HASH, workspaceBaseSha256: base });
});

it("retains the verified workspace base during recovery from an untouched restore failure", async () => {
  const base = "b".repeat(64), f = setup(base), attachments = vi.spyOn(f.host, "prepareAttachments");
  await f.session.restore(snapshot, { replacedId:"123e4567-e89b-42d3-a456-426614174002" });
  f.order.length=0;
  f.setFileDifferences({workspace:true,root:false});
  f.failStorage("stage-native-workspace");
  await expect(f.session.restore(snapshot, { replacedId: "123e4567-e89b-42d3-a456-426614174002" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(f.order).toContain("recovery-begin");
  expect(attachments.mock.calls.at(-1)?.[1]).toBe(true);
  expect(attachments.mock.calls.at(-1)?.[3]).toEqual({ rootTreeSha256: HASH, workspaceBaseSha256: base });
});

it("an explicit initial point uses startup admission without taking an empty-scaffold recovery or reconciling current files",async()=>{
 const f=setup();await f.session.restore(snapshot,{startup:true});
 expect(f.order).not.toContain("open-native-capture");expect(f.order).not.toContain("workspace-reconcile");
 expect(f.requests.filter(request=>request.type==="prepare-native-restore")).toMatchObject([{snapshot,recovery:snapshot}]);
});
