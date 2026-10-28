import {afterEach,expect,it,vi} from "vitest";
import {inspectStoredStartImage,inspectStoredNativeStart} from "./startup-image.js";
import type {InspectStartImageRequest} from "../protocol/start-image.js";
import {MemoryDirectory,MemoryFile} from "./opfs-double.test-support.js";
import {RootfsStore} from "./rootfs-store.js";
import {RootfsNetworkClient,serveRootfsNetwork} from "./rootfs-network-channel.js";
import {signedCheckpointRootfsFixture,ROOTFS_CHECKPOINT_URL} from "./rootfs-checkpoint.test-support.js";
import {SnapshotCatalog} from "./snapshot-catalog.js";
import {SnapshotObjects} from "./snapshot-objects.js";
import type {UserspaceSnapshotManifest} from "./snapshot-manifest.js";
import {WorkspaceSelections} from "./workspace-selections.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";
import {sha256Hex} from "./snapshot-content.js";
const signal=()=>new AbortController().signal;
const ports:MessagePort[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const port of ports.splice(0))port.close();});
const snapshot={id:"123e4567-e89b-42d3-a456-426614174001",createdAt:"2026-10-13T00:00:00.000Z"};
// Saved state signed by another key than the app now configures: typed, names the old key and the way out.
const trustChanged={code:"PROTOCOL_ERROR",detail:{reason:"image-trust-changed",keyId:"test"}};
function request(key:Uint8Array):InspectStartImageRequest {return {workspaceId:"workspace-a",mode:"userspace",resume:"latest",manifestUrl:"https://profiles.example/new-default.json",manifestSHA256:"b".repeat(64),trustedKeyId:"test",trustedPublicKey:key};}
async function saved(schemaVersion:3|6=6) {
  const fixture=await signedCheckpointRootfsFixture("2026.10.13",schemaVersion);
  const origin=new MemoryDirectory();
  const oxidevm=await origin.getDirectoryHandle("oxidevm",{create:true});
  const workspace=await (await oxidevm.getDirectoryHandle("workspaces",{create:true})).getDirectoryHandle("workspace-a",{create:true});
  const overlay=await (await oxidevm.getDirectoryHandle("workspace-overlays",{create:true})).getDirectoryHandle("workspace-a",{create:true});
  const channel=new MessageChannel();ports.push(channel.port1,channel.port2);serveRootfsNetwork(channel.port2);
  const roots=RootfsStore.opfs(oxidevm,new RootfsNetworkClient(channel.port1));
  const prepared=await roots.prepare(ROOTFS_CHECKPOINT_URL,fixture.trusted);
  const captured=await roots.captureCheckpoint({workspaceId:"workspace-a",snapshotId:snapshot.id});
  const directory=await workspace.getDirectoryHandle("snapshots-v2",{create:true});
  const objects=await SnapshotObjects.open(directory);
  const catalog=new SnapshotCatalog(directory,objects);
  const graph=await objects.put(new Uint8Array([1]));
  const manifest:UserspaceSnapshotManifest={schema:4,mode:"userspace",...snapshot,kind:"automatic",capturedAtUnixMs:Date.parse(snapshot.createdAt),parent:null,compatibility:{format:"OXUC",version:1,abiVersion:38,memoryBytes:256*1024**2},graph:{bytes:1,chunks:[{...graph,index:0}]},payloads:{bytes:0,chunks:[]},rootfs:captured.rootfs};
  await catalog.commit(manifest);
  await new WorkspaceSelections(opfsWorkspaceStoreBackend(overlay)).setSession({resume:snapshot.id});
  return {origin,fixture,prepared,oxidevm,catalog,manifest,roots};
}
it("inspects a signed native retained image offline before taking a workspace lease",async()=>{
  const f=await saved();
  const offline=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",offline);
  const result=await inspectStoredStartImage(f.origin,request(f.fixture.trusted.publicKey),signal());
  expect(result).toMatchObject({image:{id:"test-rootfs",version:"2026.10.13",mode:"userspace",cpuProfile:"x86-64-v2",manifestSHA256:await sha256Hex(f.fixture.bytes),keyId:"test",signatureVerified:true},manifestUrl:ROOTFS_CHECKPOINT_URL,memoryMiB:256});
  expect(result?.image).toEqual(f.prepared.identity);expect(offline).not.toHaveBeenCalled();
});

it("uses an installed native image for a new workspace without a second public manifest download",async()=>{
  const f=await saved();
  await f.roots.prepareImage({workspaceId:"workspace-a",snapshotId:snapshot.id},signal(),()=>{},"first-install");
  const offline=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",offline);
  const input={...request(f.fixture.trusted.publicKey),workspaceId:"new-workspace",manifestUrl:ROOTFS_CHECKPOINT_URL,manifestSHA256:await sha256Hex(f.fixture.bytes)};
  expect(await inspectStoredStartImage(f.origin,input,signal())).toMatchObject({image:f.prepared.identity});
  expect(offline).not.toHaveBeenCalled();
  await expect(inspectStoredStartImage(f.origin,{...input,trustedKeyId:"foreign"},signal())).rejects.toMatchObject(trustChanged);
  await expect(inspectStoredStartImage(f.origin,{...input,trustedKeyId:"foreign"},signal())).rejects.toThrow(/\(test\); open it with resume: "update-image"/u);
});

it("does not parse and authenticate the same requested image again merely to check a cached update offer",async()=>{
  const f=await saved(),verification=vi.spyOn(crypto.subtle,"verify");
  expect(await inspectStoredStartImage(f.origin,{...request(f.fixture.trusted.publicKey),manifestUrl:ROOTFS_CHECKPOINT_URL,
    manifestSHA256:await sha256Hex(f.fixture.bytes)},signal())).toMatchObject({image:f.prepared.identity});
  expect(verification).toHaveBeenCalledOnce();verification.mockRestore();
});
it("resumes diagnostic schema3 rootfs offline with the same trust without claiming a public signed identity",async()=>{
  const f=await saved(3),input=request(f.fixture.trusted.publicKey),wrong=await signedCheckpointRootfsFixture("foreign",3);
  const offline=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",offline);
  expect(await inspectStoredNativeStart(f.origin,input,signal())).toEqual({manifestUrl:ROOTFS_CHECKPOINT_URL,manifestSHA256:await sha256Hex(f.fixture.bytes)});
  expect(f.prepared.identity).toBeUndefined();
  await expect(inspectStoredStartImage(f.origin,input,signal())).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  await expect(inspectStoredNativeStart(f.origin,{...input,trustedKeyId:"foreign"},signal())).rejects.toThrow();
  await expect(inspectStoredNativeStart(f.origin,{...input,trustedPublicKey:wrong.trusted.publicKey},signal())).rejects.toThrow();
  const overlay=await (await f.oxidevm.getDirectoryHandle("workspace-overlays")).getDirectoryHandle("workspace-a");
  await new WorkspaceSelections(opfsWorkspaceStoreBackend(overlay)).setSession({resume:null,image:snapshot.id});
  expect(await inspectStoredNativeStart(f.origin,input,signal())).toEqual({manifestUrl:ROOTFS_CHECKPOINT_URL,manifestSHA256:await sha256Hex(f.fixture.bytes)});
  await expect(inspectStoredStartImage(f.origin,input,signal())).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  expect(offline).not.toHaveBeenCalled();
});
it("inspects existing storage without creating directories and honors reset/update/cancellation",async()=>{
  const origin=new MemoryDirectory();const directories=vi.spyOn(origin,"getDirectoryHandle");
  const input=request(new Uint8Array(44));
  expect(await inspectStoredStartImage(origin,input,signal())).toBeNull();
  expect(directories).toHaveBeenCalledWith("oxidevm");await expect(origin.getDirectoryHandle("oxidevm")).rejects.toMatchObject({name:"NotFoundError"});
  directories.mockClear();
  for(const resume of ["fresh-image","update-image"] as const)expect(await inspectStoredStartImage(origin,{...input,resume},signal())).toBeNull();
  expect(directories).not.toHaveBeenCalled();
  const cancelled=new AbortController();cancelled.abort();await expect(inspectStoredStartImage(origin,input,cancelled.signal)).rejects.toMatchObject({code:"ABORTED"});
});
it("rejects cross-runtime, mismatched references, trust changes and damaged rootfs pins",async()=>{
  const f=await saved();const input=request(f.fixture.trusted.publicKey);
  await expect(inspectStoredStartImage(f.origin,{...input,mode:"system",resume:snapshot},signal())).rejects.toMatchObject({code:"FEATURE_NOT_AVAILABLE",detail:{reason:"runtime-mismatch"}});
  await expect(inspectStoredStartImage(f.origin,{...input,resume:{...snapshot,createdAt:"2026-10-12T00:00:00.000Z"}},signal())).rejects.toMatchObject({code:"STORAGE_NOT_FOUND"});
  await expect(inspectStoredStartImage(f.origin,{...input,trustedKeyId:"foreign"},signal())).rejects.toMatchObject(trustChanged);
  await f.catalog.commit({...f.manifest,rootfs:{...f.manifest.rootfs,rootTreeSha256:"a".repeat(64)}});
  await expect(inspectStoredStartImage(f.origin,input,signal())).rejects.toMatchObject({code:"STORAGE_ERROR"});
  await expect(inspectStoredNativeStart(f.origin,input,signal())).rejects.toMatchObject({code:"STORAGE_ERROR"});
});

it("selects the authenticated retained image without scanning bodies before restore admission", async () => {
  const f = await saved();
  const body = f.origin.find(`oxidevm/userspace-rootfs/blobs/${f.fixture.blobHash}`);
  if (!(body instanceof MemoryFile)) throw new Error("missing immutable fixture");
  const reads = vi.spyOn(body, "getFile"), input = request(f.fixture.trusted.publicKey);
  expect(await inspectStoredStartImage(f.origin, input, signal())).toMatchObject({ image: { signatureVerified: true } });
  expect(await inspectStoredNativeStart(f.origin, input, signal())).toMatchObject({ manifestUrl: ROOTFS_CHECKPOINT_URL });
  expect(reads).not.toHaveBeenCalled();
});

it("retains an independent verified running image after clearing resume and deleting its checkpoint",async()=>{
 const f=await saved(),image="123e4567-e89b-42d3-a456-426614174002";
 await f.roots.captureCheckpoint({workspaceId:"workspace-a",snapshotId:image});
 const overlay=await (await f.oxidevm.getDirectoryHandle("workspace-overlays")).getDirectoryHandle("workspace-a");
 await new WorkspaceSelections(opfsWorkspaceStoreBackend(overlay)).setSession({resume:null,image});
 await f.catalog.delete(snapshot.id);await f.roots.releaseCheckpoint({workspaceId:"workspace-a",snapshotId:snapshot.id});
 const offline=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",offline);
 const result=await inspectStoredStartImage(f.origin,{...request(f.fixture.trusted.publicKey),resume:"none"},signal());
 expect(result?.image).toEqual(f.prepared.identity);expect(offline).not.toHaveBeenCalled();
});
