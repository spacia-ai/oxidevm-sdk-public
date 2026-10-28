import { afterEach, expect, it, vi } from "vitest";
import { UserspaceManagedSession } from "./userspace-managed-session.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { WorkerClient } from "./worker-client.js";
import { controlResponseDecoders, storageResponseDecoders, type ControlOperations, type StorageOperations, type SnapshotInfo } from "./protocol.js";

const saved: SnapshotInfo = { mode: "userspace", ref: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-13T00:00:00.000Z" },
  kind: "automatic", capturedAtUnixMs: 1, profile: { id: "alpine", version: "v1" }, bytes: { ram: 1, disk: 1, unique: 1 }, resumable: true };
const rootfs = { id: "alpine", version: "v1", rootTreeSha256: "a".repeat(64), cpuProfile: "x86-64-v2",
  fileCount: 1, totalBytes: 1, metadata: new Uint8Array(4), runtimes: { node: "usr/bin/node", bun: "usr/bin/bun", supportingFiles: [] } };
const clients: { terminate(): void }[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.terminate()); ScriptedWorker.reset(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://example.test/"));
  const control = new WorkerClient<ControlOperations>(new Worker("", { name: "oxidevm-control" }), controlResponseDecoders);
  const storage = new WorkerClient<StorageOperations>(new Worker("", { name: "oxidevm-storage" }), storageResponseDecoders); clients.push(control, storage);
  const attached: number[] = [], replayed: Uint8Array[] = [];
  ScriptedWorker.answers.set("prepare-userspace-rootfs", () => rootfs);
  ScriptedWorker.answers.set("current-userspace-rootfs", () => rootfs);
  ScriptedWorker.answers.set("current-userspace-image", () => ({ id: "alpine", version: "v1", mode: "userspace", cpuProfile: "x86-64-v2", manifestSHA256: "a".repeat(64), keyId: "test", signatureVerified: true }));
  ScriptedWorker.answers.set("select-userspace-files", () => ({sourceId:saved.ref.id}));
  ScriptedWorker.answers.set("start-userspace-cold", () => ({state:"in-sync",conflicts:[],omittedConflicts:0}));
  ScriptedWorker.answers.set("configure-userspace-checkpoints", () => undefined);
  ScriptedWorker.answers.set("snapshot-resume-candidates", () => [saved]);
  ScriptedWorker.answers.set("snapshot-list", () => [saved]);
  const restored = { newerFilesDropped: true, appData: new Uint8Array([4]), consoleTail: new Uint8Array(),
    processes: [{ mode: "userspace", pid: 5, attachmentKey: 12, terminalKey: 8, command: "sh", terminal: true, tail: new Uint8Array([3]) }] };
  ScriptedWorker.answers.set("restore-userspace-checkpoint", () => restored); ScriptedWorker.answers.set("restore", () => restored);
  const session = new UserspaceManagedSession({ control, storage, rootPersistence: "persistent", observe: () => Promise.resolve(),
    restored: () => Promise.resolve(), attachProcess: (key, _terminal, tail) => { attached.push(key); replayed.push(tail); return Promise.reject(new Error("attached")); } });
  return { session, attached, replayed, control: ScriptedWorker.named("oxidevm-control"), storage: ScriptedWorker.named("oxidevm-storage") };
}
const options = { trustedKeyId: "test", trustedPublicKey: new Uint8Array(32), resume: "latest" as const };

it.each(["none", "latest"] as const)("completes image installation before admitting a %s session", async resume => {
  const f = setup(); ScriptedWorker.answers.set("prepare-image", () => undefined);
  await f.session.boot("https://example.test/rootfs.json", { ...options, resume, imagePreparation: "before-ready" });
  const installed = f.control.operations.indexOf("prepare-image");
  expect(installed).toBeGreaterThanOrEqual(0);
  expect(installed).toBeLessThan(f.control.operations.indexOf(resume === "none" ? "start-userspace-cold" : "restore-userspace-checkpoint"));
});

it("does not select durable files or start execution after installation failure", async () => {
  const f = setup();
  ScriptedWorker.answers.set("prepare-image", () => { throw new Error("installation refused"); });
  await expect(f.session.boot("https://example.test/rootfs.json", { ...options, resume: "none", imagePreparation: "before-ready" })).rejects.toThrow("installation refused");
  expect(f.storage.operations).not.toContain("select-userspace-files");
  expect(f.control.operations).not.toContain("start-userspace-cold");
});

it("prepares the selected running image explicitly without restarting its guest", async () => {
  const f = setup(); ScriptedWorker.answers.set("prepare-image", () => undefined);
  await f.session.boot("https://example.test/rootfs.json", options);
  const restored = f.control.operations.filter(operation => operation === "restore-userspace-checkpoint").length;
  await f.session.prepareImage();
  expect(f.control.inputs.find(input => input["type"] === "prepare-image")).toMatchObject({ reason: "repair" });
  expect(f.control.operations.filter(operation => operation === "restore-userspace-checkpoint")).toHaveLength(restored);
});

it("resumes through the native coordinator and adopts the existing process without spawning a shell", async () => {
  const f = setup(); const image = await f.session.boot("https://example.test/rootfs.json", options);
  expect(image.start).toMatchObject({ kind: "resumed", terminals: [{ key: "process:8", command: "sh", screenTail: new Uint8Array([3]) }] });
  const terminal = image.start?.kind === "resumed" ? image.start.terminals[0] : undefined;
  if (terminal?.source !== "process") throw new Error("missing restored terminal");
  await expect(terminal.attach()).rejects.toThrow("attached"); expect(f.attached).toEqual([12]);
  expect(f.replayed).toEqual([new Uint8Array([3])]);
  expect(f.control.inputs.find(input => input["type"] === "restore-userspace-checkpoint")).toHaveProperty("replacedId");
  expect(f.control.operations).not.toContain("spawn-managed");
});

it("selects cold durable files before mounting and keeps explicit restore separate from startup reconciliation", async () => {
  const f = setup();
  const boot = await f.session.boot("https://example.test/rootfs.json", { ...options, resume: "pre-resume" });
  expect(boot.start).toMatchObject({ kind: "booted", reason: "restart" });
  expect(f.storage.inputs.find(input => input["type"] === "select-userspace-files")).toMatchObject({ boot: "pre-resume" });
  await f.session.restore(saved.ref);
  expect(f.control.inputs.find(input => input["type"] === "restore")).not.toHaveProperty("replacedId");
});

it("reports cold workspace migration from the selected files rather than image preparation", async () => {
  const f = setup();
  const workspaceDetails = { state: "conflict-preserved", conflicts: [], omittedConflicts: 0,
    preserved: { id: "3", reason: "base-unavailable" } };
  ScriptedWorker.answers.set("start-userspace-cold", () => workspaceDetails);
  const image = await f.session.boot("https://example.test/rootfs.json", { ...options, resume: "none" });
  expect(image.start).toMatchObject({ kind: "booted", workspaceDetails });
});

it("resumes without selecting or migrating current workspace files before native reconciliation", async () => {
  const f = setup();
  ScriptedWorker.answers.set("select-userspace-files", () => { throw new Error("cold bulk migration must not run during resume"); });
  expect((await f.session.boot("https://example.test/rootfs.json", options)).start?.kind).toBe("resumed");
  expect(f.storage.operations).not.toContain("select-userspace-files");
});

it("reports native startup reconciliation instead of saying the workspace is unchanged", async () => {
  const f = setup();
  ScriptedWorker.answers.set("restore-userspace-checkpoint", () => ({ newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [],
    workspace: { workspace: "conflict-preserved", unresolved: ["/workspace/edited"] } }));
  const image = await f.session.boot("https://example.test/rootfs.json", options);
  expect(image.start).toMatchObject({ kind: "resumed", workspace: "conflict-preserved", newerFilesDropped: false });
});

it("preserves bounded native conflict details on the normalized start", async () => {
  const f = setup();
  const workspaceDetails = { state: "conflict-preserved", conflicts: [{ path: "/workspace/edited", reason: "changed-in-both" }], omittedConflicts: 0 };
  ScriptedWorker.answers.set("restore-userspace-checkpoint", () => ({ newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [],
    workspace: { workspace: "conflict-preserved", unresolved: [] }, workspaceDetails }));
  const image = await f.session.boot("https://example.test/rootfs.json", options);
  expect(image.start).toMatchObject({ kind: "resumed", workspace: "conflict-preserved", workspaceDetails });
});

it("offers the requested image while a cold restart retains the older image", async () => {
  const f = setup();
  ScriptedWorker.answers.set("prepare-userspace-rootfs", () => ({ ...rootfs, update: { id: "alpine", version: "v2" } }));
  const image = await f.session.boot("https://example.test/rootfs.json", { ...options, resume: "none" });
  expect(image).toMatchObject({ id: "alpine", version: "v1", update: { id: "alpine", version: "v2" } });
});

it("retires selected cold file pins when configuration fails before native dispatch",async()=>{
 const f=setup();
 ScriptedWorker.answers.set("configure-userspace-checkpoints",()=>{throw new Error("mount rejected");});
 ScriptedWorker.answers.set("abort-userspace-files",()=>undefined);
 await expect(f.session.boot("https://example.test/rootfs.json",{...options,resume:"none"})).rejects.toThrow("mount rejected");
 expect(f.storage.inputs.find(input=>input["type"]==="abort-userspace-files")).toMatchObject({sourceId:saved.ref.id});
 expect(f.control.operations).not.toContain("start-userspace-cold");
});

it("cold fallback follows a failed automatic candidate with the selected streamed transaction",async()=>{
 const f=setup();
 ScriptedWorker.answers.set("restore-userspace-checkpoint",()=>{throw new Error("unpublished candidate discarded and remounted");});
 const result=await f.session.boot("https://example.test/rootfs.json",options);
 expect(result.start).toMatchObject({kind:"booted",reason:"restore-failed",workspaceDetails:{state:"in-sync"}});
 expect(f.control.operations.filter(type=>type==="configure-userspace-checkpoints")).toHaveLength(1);
 expect(f.control.inputs.find(input=>input["type"]==="start-userspace-cold")).toMatchObject({sourceId:saved.ref.id});
});

it("marks a requested initial point as startup without applying automatic workspace reconciliation",async()=>{
 const f=setup();await f.session.boot("https://example.test/rootfs.json",{...options,resume:saved.ref});
 const request=f.control.inputs.find(input=>input["type"]==="restore-userspace-checkpoint");
 expect(request).toMatchObject({startup:true,snapshot:saved.ref});expect(request).not.toHaveProperty("replacedId");
 expect(f.storage.operations).not.toContain("select-userspace-files");
});

it("retires the selected cold source when startup is cancelled after selection and before native dispatch",async()=>{
 const f=setup(),cancellation=new AbortController();
 ScriptedWorker.answers.set("configure-userspace-checkpoints",()=>{cancellation.abort();return undefined;});
 ScriptedWorker.answers.set("abort-userspace-files",()=>undefined);
 await expect(f.session.boot("https://example.test/rootfs.json",{...options,resume:"none",signal:cancellation.signal})).rejects.toMatchObject({code:"ABORTED"});
 expect(f.storage.inputs.find(input=>input["type"]==="abort-userspace-files")).toMatchObject({sourceId:saved.ref.id});
 expect(f.control.operations).not.toContain("start-userspace-cold");
});
