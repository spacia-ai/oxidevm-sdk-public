import {expect,it} from "vitest";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {InitialStart} from "./initial-start.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";
import {WorkspaceStore} from "./workspace-store.js";
import {workspaceBytesInput} from "./workspace-stream.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";
import {writeDiskHead} from "./managed-disk-head.js";
import {openUserspaceRootStore} from "./userspace-root-store.js";
import {writeOpfsFile} from "./snapshot-objects.js";
const source=decodeShippedInstallIdentity({mode:"userspace",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});
it("an_interrupted_v2_source_creation_can_retry_without_erasing_user_files",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  root.directory("initial-start-v2",true).file("source.json",true);
  const initial=await InitialStart.open(root,backend);
  expect(initial.state()).toEqual({kind:"empty"});
  await initial.begin(source);
  expect(root.directory("initial-start-v2",false).file("source.json",false).bytes.length).toBeGreaterThan(0);
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"pending",source});
});
it("legacy_files_without_snapshot_are_existing",async()=>{
  const root=new MemoryDirectory(),overlay=new MemoryDirectory();
  const backend=opfsWorkspaceStoreBackend(overlay);
  await new WorkspaceStore(backend).commitStreams("a".repeat(64),{snapshot:workspaceBytesInput(new Uint8Array([7])),delta:workspaceBytesInput(new Uint8Array())},new AbortController().signal);
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"existing"});
  expect(await new WorkspaceStore(backend).read("a".repeat(64))).toEqual(new Uint8Array([7]));
});
it("cached_image_alone_is_empty",async()=>{
  const root=new MemoryDirectory(),overlay=new MemoryDirectory();
  root.directory("managed-images",true);
  expect((await InitialStart.open(root,opfsWorkspaceStoreBackend(overlay))).state()).toEqual({kind:"empty"});
});
it("pending_same_source_retries_and_other_source_conflicts",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  const initial=await InitialStart.open(root,backend);
  await initial.begin(source);
  const reopened=await InitialStart.open(root,backend);
  expect(reopened.state()).toEqual({kind:"pending",source});
  await expect(reopened.begin(source)).resolves.toEqual({kind:"pending",source});
  await expect(reopened.begin({...source,mode:"system"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("a deliberate committed startup durably retires the pending source",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  const initial=await InitialStart.open(root,backend);await initial.begin(source);await initial.retire();
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"existing"});
  await expect((await InitialStart.open(root,backend)).begin(source)).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("an interrupted empty retirement keeps its original source pending",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await (await InitialStart.open(root,backend)).begin(source);root.file("initial-start-retired.json",true);
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"pending",source});
});
it("conflicting_legacy_and_v2_intents_are_not_selected_by_precedence",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await (await InitialStart.open(root,backend)).begin(source);
  await writeOpfsFile(root,"initial-start.json",new TextEncoder().encode(JSON.stringify({format:"oxidevm-initial-start",version:1,source:{...source,snapshotManifestSHA256:"ef".repeat(32)}})));
  await expect(InitialStart.open(root,backend)).rejects.toMatchObject({code:"STORAGE_ERROR"});
});
it("malformed_durable_metadata_never_becomes_empty",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await backend.write("active.json",new TextEncoder().encode("{}"));
  await expect(InitialStart.open(root,backend)).rejects.toThrow();
});
it("interruption_before_image_prepare_remains_retryable",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await (await InitialStart.open(root,backend)).begin(source);
  await writeDiskHead(root.directory("managed-disks",true),{schema:1,generation:"alpine",previous:null,resume:null});
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"pending",source});
});
it("completed_head_takes_priority_over_pending_intent",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await (await InitialStart.open(root,backend)).begin(source);
  await writeDiskHead(root.directory("managed-disks",true),{schema:2,generation:"alpine",previous:null,resume:null,initialStart:source});
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"existing"});
  expect(root.names()).not.toContain("initial-start.json");
});
it("completed_head_also_wins_over_a_damaged_obsolete_intent",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await writeOpfsFile(root,"initial-start.json",new TextEncoder().encode("partial old intent"));
  await writeDiskHead(root.directory("managed-disks",true),{schema:2,generation:"alpine",previous:null,resume:null,initialStart:source});
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"existing"});
});
it("persistent_root_without_workspace_is_existing",async()=>{
  const root=new MemoryDirectory(),backend=opfsWorkspaceStoreBackend(new MemoryDirectory());
  await (await openUserspaceRootStore(backend,"a".repeat(64))).commitStreams("a".repeat(64),{snapshot:workspaceBytesInput(new Uint8Array([9])),delta:workspaceBytesInput(new Uint8Array())},new AbortController().signal);
  expect((await InitialStart.open(root,backend)).state()).toEqual({kind:"existing"});
});
