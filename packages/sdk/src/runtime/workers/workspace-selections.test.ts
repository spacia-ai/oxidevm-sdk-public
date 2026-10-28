import { expect, it } from "vitest";
import { WorkspaceSelections } from "./workspace-selections.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";
import { record } from "../decode.js";

const BASE = "a".repeat(64);
const ROOT = "b".repeat(64);
const SAVED = "11111111-2222-4333-8444-555555555555";
const BEFORE = "22222222-2222-4333-8444-555555555555";
const CANDIDATE = "33333333-2222-4333-8444-555555555555";
const INITIAL=decodeShippedInstallIdentity({mode:"userspace",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});

function fixture() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let fail: "before-head" | "after-head" | undefined;
  const backend: WorkspaceStoreBackend = {
    async *list(prefix) { for (const key of files.keys()) if (key.startsWith(prefix)) yield await Promise.resolve(key); },
    read: (path) => Promise.resolve(files.get(path)?.slice()),
    write: (path, bytes) => {
      if (path === "selections/head.json" && fail === "before-head") return Promise.reject(new Error("lost writer"));
      files.set(path, bytes.slice());
      if (path === "selections/head.json" && fail === "after-head") return Promise.reject(new Error("lost acknowledgement"));
      return Promise.resolve();
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
  return { files, backend, fail: (value: typeof fail) => { fail = value; } };
}

async function write(backend: WorkspaceStoreBackend, value: number) {
  const workspace = new WorkspaceStore(backend);
  const root = await openUserspaceRootStore(backend, ROOT);
  const signal = new AbortController().signal;
  await workspace.commitStreams(BASE, { snapshot: workspaceBytesInput(new Uint8Array([value])), delta: workspaceBytesInput(new Uint8Array()) }, signal);
  await root.commitStreams(ROOT, { snapshot: workspaceBytesInput(new Uint8Array([value + 1])), delta: workspaceBytesInput(new Uint8Array()) }, signal);
}

async function read(backend: WorkspaceStoreBackend) {
  return [await new WorkspaceStore(backend).read(BASE), await (await openUserspaceRootStore(backend, ROOT)).read(ROOT)];
}

it("publishes workspace and root together, retaining the replaced pair for restart", async () => {
  const { backend } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  await selections.retain(SAVED, ROOT);
  await write(selections.backend, 3);
  await selections.retain(BEFORE, ROOT);
  await selections.publish(SAVED, new AbortController().signal);
  expect(await read(selections.backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  const reopened = new WorkspaceSelections(backend);
  await reopened.publish(BEFORE, new AbortController().signal);
  expect(await read(reopened.backend)).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});
it.each(["before-head","after-head"] as const)("initialization_failure_cut_%s_preserves_old_or_complete_new_head",async(cut)=>{
  const f=fixture(),selections=new WorkspaceSelections(f.backend);
  await write(selections.backend,1);
  const staged=await selections.stage(CANDIDATE,ROOT);
  await write(staged.backend,5);
  f.fail(cut);
  const commit=staged.commit(new AbortController().signal,{resume:SAVED},undefined,INITIAL);
  if(cut==="before-head")await expect(commit).rejects.toThrow("lost writer");
  else await commit;
  const reopened=new WorkspaceSelections(f.backend);
  const evidence=await reopened.initialStartEvidence();
  expect(evidence.initialStart).toEqual(cut==="before-head"?undefined:INITIAL);
  expect(await read(reopened.backend)).toEqual(cut==="before-head"?[new Uint8Array([1]),new Uint8Array([2])]:[new Uint8Array([5]),new Uint8Array([6])]);
});

it("stages imported streams without exposing either generation until publication", async () => {
  const { backend } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  await selections.retain(BEFORE, ROOT);
  const staged = await selections.stage(CANDIDATE, ROOT);
  await write(staged.backend, 5);
  expect(await read(selections.backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  await staged.commit(new AbortController().signal);
  expect(await read(new WorkspaceSelections(backend).backend)).toEqual([new Uint8Array([5]), new Uint8Array([6])]);
  await selections.publish(BEFORE, new AbortController().signal);
  expect(await read(selections.backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
});

it("keeps staged writer loss and abort isolated from the running generations", async () => {
  const { backend, files } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  const staged = await selections.stage(CANDIDATE, ROOT);
  await write(staged.backend, 5);
  const candidate = await staged.backend.read("active.json");
  if (candidate === undefined) throw new Error("missing candidate");
  await staged.backend.write("intent.json", candidate);
  expect(files.get("intent.json")).not.toEqual(candidate);
  expect(await read(new WorkspaceSelections(backend).backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  await expect(write(selections.backend, 7)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await staged.abort();
  expect(await read(selections.backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  await expect(staged.backend.write("active.json", candidate)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it.each(["before-head", "after-head"] as const)("resolves a failed selection write by its committed head (%s)", async timing => {
  const storage = fixture();
  const selections = new WorkspaceSelections(storage.backend);
  await write(selections.backend, 1);
  await selections.retain(SAVED, ROOT);
  await write(selections.backend, 3);
  await selections.retain(BEFORE, ROOT);
  storage.fail(timing);
  const publication = selections.publish(SAVED, new AbortController().signal);
  if (timing === "before-head") await expect(publication).rejects.toThrow("lost writer");
  else await publication;
  storage.fail(undefined);
  expect(await read(new WorkspaceSelections(storage.backend).backend)).toEqual(timing === "before-head"
    ? [new Uint8Array([3]), new Uint8Array([4])] : [new Uint8Array([1]), new Uint8Array([2])]);
});

it("aborts before selection and validates every referenced stream before committing", async () => {
  const { backend, files } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  await selections.retain(SAVED, ROOT);
  await write(selections.backend, 3);
  const controller = new AbortController(); controller.abort();
  await expect(selections.publish(SAVED, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  const data = [...files].find(([path, bytes]) => !path.startsWith("userspace-roots/") && bytes.length === 1 && bytes[0] === 1);
  expect(data).toBeDefined();
  if (data === undefined) throw new Error("missing staged object");
  files.delete(data[0]);
  await expect(selections.publish(SAVED, new AbortController().signal)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(await read(selections.backend)).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});

it("commits native resume and restart pointers with the selected file pair", async () => {
  const storage = fixture();
  const selections = new WorkspaceSelections(storage.backend);
  await write(selections.backend, 1);
  await selections.retain(SAVED, ROOT);
  await selections.setSession({ resume: SAVED });
  await write(selections.backend, 3);
  await selections.retain(BEFORE, ROOT);
  storage.fail("before-head");
  await expect(selections.publish(SAVED, new AbortController().signal, { resume: SAVED, replaced: BEFORE })).rejects.toThrow();
  expect(await selections.session()).toEqual({ resume: SAVED });
  storage.fail(undefined);
  await selections.publish(SAVED, new AbortController().signal, { resume: SAVED, replaced: BEFORE });
  expect(await new WorkspaceSelections(storage.backend).session()).toEqual({ resume: SAVED, replaced: BEFORE });
  await write(selections.backend, 5);
  expect(await selections.session()).toEqual({ resume: SAVED, replaced: BEFORE });
  await selections.publish(BEFORE, new AbortController().signal, { resume: null });
  expect(await selections.session()).toEqual({ resume: null });
  expect(await read(selections.backend)).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});

it("reclaims released native file pins through workspace staging while retaining live generations", async () => {
  const { backend, files } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  await selections.retain(SAVED, ROOT);
  await write(selections.backend, 3);
  await selections.retain(BEFORE, ROOT);
  const retired = [...files].filter(([path, bytes]) => path.includes("chunks/") && bytes.length === 1 && bytes[0] === 1).map(([path]) => path);
  expect(retired).toHaveLength(1);
  await selections.collect(new Set([BEFORE]));
  expect(await selections.has(SAVED)).toBe(false);
  expect(await selections.has(BEFORE)).toBe(true);
  expect(retired.every(path => !files.has(path))).toBe(true);
  expect(await read(selections.backend)).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
});

it("selects cold live/pre-resume files while retiring checkpoint pointers and preserving kept pairs",async()=>{
 const {backend}=fixture(),selection=new WorkspaceSelections(backend),signal=new AbortController().signal;
 await write(selection.backend,1);await selection.retain(BEFORE,ROOT);
 await write(selection.backend,3);await selection.setSession({resume:SAVED,replaced:BEFORE,recovery:CANDIDATE});
 expect(await selection.selectBoot("live",ROOT,CANDIDATE,signal)).toEqual({});
 expect(await read(selection.backend)).toEqual([new Uint8Array([3]),new Uint8Array([4])]);
 expect(await selection.session()).toEqual({resume:null,image:CANDIDATE,replaced:BEFORE});
 expect(await selection.selectBoot("pre-resume",ROOT,SAVED,signal)).toEqual({replaced:BEFORE});
 expect(await read(new WorkspaceSelections(backend).backend)).toEqual([new Uint8Array([1]),new Uint8Array([2])]);
 expect(await selection.session()).toEqual({resume:null,image:SAVED});expect(await selection.has(BEFORE)).toBe(true);
});
it("fresh selection hides legacy active files and unfinished journals atomically",async()=>{
 const f=fixture(),selection=new WorkspaceSelections(f.backend),signal=new AbortController().signal;
 await write(selection.backend,1);await selection.retain(SAVED,ROOT);
 const pending=await selection.backend.read("active.json");if(pending===undefined)throw new Error("missing files");
 await f.backend.write("active.json",pending);await f.backend.write("intent.json",pending);
 await f.backend.write(`userspace-roots/${ROOT}/intent.json`,await selection.backend.read(`userspace-roots/${ROOT}/active.json`)??pending);
 await selection.selectBoot("fresh-image",ROOT,CANDIDATE,signal);
 expect(await read(new WorkspaceSelections(f.backend).backend)).toEqual([undefined,undefined]);
 expect(await selection.backend.read("intent.json")).toBeUndefined();
 expect(await selection.backend.read(`userspace-roots/${ROOT}/intent.json`)).toBeUndefined();
 expect(await selection.has(SAVED)).toBe(true);
 await write(selection.backend,5);expect(await read(selection.backend)).toEqual([new Uint8Array([5]),new Uint8Array([6])]);
});
it("update preserves workspace and the destination image's own durable root",async()=>{
 const {backend}=fixture(),selection=new WorkspaceSelections(backend),signal=new AbortController().signal,other="c".repeat(64);
 await write(selection.backend,1);
 const destination=await openUserspaceRootStore(selection.backend,other);
 await destination.commitStreams(other,{snapshot:workspaceBytesInput(new Uint8Array([9])),delta:workspaceBytesInput(new Uint8Array())},signal);
 await selection.setSession({resume:SAVED,replaced:BEFORE});await selection.selectBoot("update-image",other,CANDIDATE,signal);
 expect(await new WorkspaceStore(selection.backend).read(BASE)).toEqual(new Uint8Array([1]));
 expect(await destination.read(other)).toEqual(new Uint8Array([9]));expect(await selection.session()).toEqual({resume:null,image:CANDIDATE});
 expect(await (await openUserspaceRootStore(selection.backend,"d".repeat(64))).read("d".repeat(64))).toBeUndefined();
});
it.each(["before-head","after-head"] as const)("retains fresh selection atomic outcome on writer failure %s",async timing=>{
 const f=fixture(),selection=new WorkspaceSelections(f.backend),signal=new AbortController().signal;
 await write(selection.backend,1);f.fail(timing);
 const selecting=selection.selectBoot("fresh-image",ROOT,CANDIDATE,signal);
 if(timing==="before-head")await expect(selecting).rejects.toThrow("lost writer");else await selecting;
 f.fail(undefined);expect(await read(new WorkspaceSelections(f.backend).backend)).toEqual(timing==="before-head"?[new Uint8Array([1]),new Uint8Array([2])]:[undefined,undefined]);
});

it("keeps retained read leases immutable and pinned through source retirement and collection",async()=>{
 const {backend}=fixture(),selection=new WorkspaceSelections(backend),signal=new AbortController().signal;
 await write(selection.backend,1);await selection.retain(SAVED,ROOT);
 const lease=await selection.retainedWorkspace(SAVED,signal,BASE);expect(lease?.workspaceBaseSha256).toBe(BASE);if(lease?.snapshot===undefined)throw new Error("missing retained source");
 await write(selection.backend,3);await selection.release(SAVED);await selection.collect(new Set());
 const producer=lease.snapshot.source(signal),frames:Uint8Array[]=[];for await(const bytes of producer.frames){expect(bytes.length).toBeLessThanOrEqual(65536);frames.push(bytes);}
 await producer.retire();expect(frames).toEqual([new Uint8Array([1])]);expect(await selection.has(SAVED)).toBe(true);
 await lease.retire();await selection.collect(new Set());expect(await selection.has(SAVED)).toBe(false);
});

it("makes obsolete physical metadata fail closed and recovers legacy files across interrupted migration",async()=>{
 const f=fixture(),signal=new AbortController().signal;
 // Write a real legacy overlay before the selection owner exists.
 await write(f.backend,1);
 const legacy=await f.backend.read("active.json");if(legacy===undefined)throw new Error("missing legacy workspace");
 f.fail("before-head");const selection=new WorkspaceSelections(f.backend);
 await expect(selection.selectBoot("fresh-image",ROOT,CANDIDATE,signal)).rejects.toThrow("lost writer");f.fail(undefined);
 await expect(new WorkspaceStore(f.backend).read(BASE)).rejects.toBeDefined();
 const reopened=new WorkspaceSelections(f.backend);
 expect(await read(reopened.backend)).toEqual([new Uint8Array([1]),new Uint8Array([2])]);
 await reopened.selectBoot("fresh-image",ROOT,CANDIDATE,signal);
 expect(await read(new WorkspaceSelections(f.backend).backend)).toEqual([undefined,undefined]);
});

it("reports actual durable differences rather than a new generation number",async()=>{
 const {backend}=fixture(),selection=new WorkspaceSelections(backend),signal=new AbortController().signal;
 await write(selection.backend,1);await selection.retain(SAVED,ROOT);
 await write(selection.backend,1);await selection.retain(BEFORE,ROOT);
 expect(await selection.differences(BEFORE,SAVED,ROOT,ROOT,signal)).toEqual({workspace:false,root:false});
 await write(selection.backend,4);await selection.retain(CANDIDATE,ROOT);
 expect(await selection.differences(CANDIDATE,SAVED,ROOT,ROOT,signal)).toEqual({workspace:true,root:true});
 expect(await selection.differences(CANDIDATE,SAVED,ROOT,undefined,signal)).toEqual({workspace:true,root:false});
});

it("reclaims a publication interrupted by a closed tab before staging, so the cold mount can open its root", async () => {
  const { backend, files } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  // A closed tab stops a root publication after its staging index and chunk were written.
  const orphan = "c".repeat(64), staging = `userspace-roots/${ROOT}/staging/44444444-2222-4333-8444-555555555555/0`;
  files.set(`userspace-roots/${ROOT}/chunks/${orphan}`, new Uint8Array([9]));
  files.set(staging, new TextEncoder().encode(JSON.stringify([`chunks/${orphan}`])));
  const reopened = new WorkspaceSelections(backend);
  const staged = await reopened.stage(CANDIDATE, ROOT, undefined);
  expect(files.has(staging)).toBe(false);
  expect(files.has(`userspace-roots/${ROOT}/chunks/${orphan}`)).toBe(false);
  // The cold mount opens the selected root while the cold candidate is staged.
  expect(await read(reopened.backend)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  await staged.abort();
});

it("still stages while an uncertain workspace publication awaits its own recovery", async () => {
  const { backend } = fixture();
  const selections = new WorkspaceSelections(backend);
  await write(selections.backend, 1);
  const active = await selections.backend.read("active.json");
  if (active === undefined) throw new Error("missing active generation");
  // An unacknowledged workspace intent that differs from the selected generation.
  const value = record(JSON.parse(new TextDecoder().decode(active)), "active manifest");
  await selections.backend.write("intent.json", new TextEncoder().encode(JSON.stringify({ ...value, generation: Number(value["generation"]) + 1 })));
  const reopened = new WorkspaceSelections(backend);
  await expect(new WorkspaceStore(reopened.backend).collect()).rejects.toMatchObject({ detail: { reason: "workspace-publication-uncertain" } });
  await expect(reopened.stage(CANDIDATE, ROOT, undefined)).resolves.toBeDefined();
});
