import { afterEach, expect, it, vi } from "vitest";
import { RootfsStore } from "./rootfs-store.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { ROOTFS_CHECKPOINT_URL, signedCheckpointRootfsFixture } from "./rootfs-checkpoint.test-support.js";
import { decodeUserspaceRootfsManifest } from "../userspace-rootfs.js";
import { sha256Hex } from "./snapshot-content.js";
import { record } from "../decode.js";

const OWNER = { workspaceId: "installed-start", snapshotId: "123e4567-e89b-42d3-a456-426614174001" };
const ports: MessagePort[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const port of ports.splice(0)) port.close(); });
function store(root: MemoryDirectory) {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  return RootfsStore.opfs(root, new RootfsNetworkClient(channel.port1));
}
async function installed(schema: 6 | 8) {
  const content = new Uint8Array(1024 ** 2 + 1).fill(7);
  const fixture = await signedCheckpointRootfsFixture("cached-start", schema, content);
  const root = new MemoryDirectory(), source = store(root);
  await source.prepare(ROOTFS_CHECKPOINT_URL, fixture.trusted, undefined, false, undefined, "before-ready");
  await source.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const saved = await source.captureCheckpoint(OWNER);
  fixture.fetcher.mockClear();
  return { ...fixture, root, source, saved, content };
}
function bodyBytes(reading: {readonly mock:{readonly contexts:readonly unknown[]}}) {
  return reading.mock.contexts.reduce<number>((total, body: unknown) => total + (body instanceof Blob && body.size > 65536 ? body.size : 0), 0);
}

it.each([6, 8] as const)("reopens an installed schema-%s image and restores without reading unused image bodies", async schema => {
  const f = await installed(schema), reopened = store(f.root);
  const reading = vi.spyOn(Blob.prototype, "arrayBuffer");
  await reopened.prepare(ROOTFS_CHECKPOINT_URL, f.trusted, f.saved.rootfs.manifest.sha256, true, undefined, "before-ready");
  await reopened.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const retire = await reopened.beginCheckpointVerification();
  try {
    await reopened.prepareCheckpoint(OWNER, f.saved.rootfs, f.saved.manifest, { manifestUrl: ROOTFS_CHECKPOINT_URL, trusted: f.trusted });
    await reopened.acquireCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, f.saved.rootfs, f.saved.manifest,
      { manifestUrl: ROOTFS_CHECKPOINT_URL, trusted: f.trusted }, "restore");
    await reopened.activateCheckpoint(OWNER, f.trusted);
    await reopened.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, undefined, { owner: OWNER, rootfs: f.saved.rootfs });
    expect(await reopened.cachedCheckpointIdentities()).toContain(f.saved.rootfs.rootTreeSha256);
    expect(bodyBytes(reading)).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await reopened.read("bin/app")).bytes).toEqual(f.content);
    expect(bodyBytes(reading)).toBeGreaterThanOrEqual(f.content.length);
  } finally { retire(); }
});

it("reuses an older complete checkpoint when no global installation pin exists", async () => {
  const fixture = await signedCheckpointRootfsFixture("old-complete", 6, new Uint8Array(1024 ** 2).fill(7));
  const root = new MemoryDirectory(), source = store(root);
  await source.prepare(ROOTFS_CHECKPOINT_URL, fixture.trusted);
  const saved = await source.captureCheckpoint(OWNER), reopened = store(root);
  const reading = vi.spyOn(Blob.prototype, "arrayBuffer"); fixture.fetcher.mockClear();
  await reopened.prepare(ROOTFS_CHECKPOINT_URL, fixture.trusted, saved.rootfs.manifest.sha256, true, undefined, "before-ready");
  await reopened.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  expect(bodyBytes(reading)).toBe(0);
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it.each([6, 8] as const)("detects same-size schema-%s corruption on use and fully verifies explicit repair", async schema => {
  const f = await installed(schema), cache = f.root.directory("userspace-rootfs", false);
  const file = schema === 6 ? cache.directory("blobs", false).file(f.blobHash, false)
    : cache.directory("packs", false).find(cache.directory("packs", false).names()[0] ?? "");
  if (!(file instanceof MemoryFile)) throw new Error("Missing fixture body");
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(f.bytes)) as unknown, new URL(ROOTFS_CHECKPOINT_URL));
  const offset = schema === 6 ? 0 : manifest.packs?.index.blobs.find(blob => blob.sha256 === f.blobHash)?.extents[0]?.offset;
  if (offset === undefined) throw new Error("Missing fixture extent");
  const changed = file.bytes; changed[offset] = (changed[offset] ?? 0) ^ 1; file.setBytes(changed);
  const reopened = store(f.root);
  await reopened.prepare(ROOTFS_CHECKPOINT_URL, f.trusted, f.saved.rootfs.manifest.sha256, true, undefined, "before-ready");
  await reopened.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const failure: unknown = await reopened.read("bin/app").then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  expect(f.fetcher).not.toHaveBeenCalled();
  await reopened.prepareImage(OWNER, new AbortController().signal, () => {}, "repair");
  expect((await reopened.read("bin/app")).bytes).toEqual(f.content);
  expect(f.fetcher.mock.calls.filter(([url]) => url.includes(schema === 6 ? "/unread" : "/packs/"))).toHaveLength(1);
});

it("refuses an installed checkpoint with a missing dependency without downloading", async () => {
  const f = await installed(8), packs = f.root.directory("userspace-rootfs", false).directory("packs", false);
  await packs.removeEntry(packs.names()[0] ?? ""); f.fetcher.mockClear();
  await expect(f.source.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, undefined, { owner: OWNER, rootfs: f.saved.rootfs }))
    .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("hashes the cached manifest only once during local rootfs preparation",async()=>{
  const f=await installed(6),reopened=store(f.root),hashing=vi.spyOn(crypto.subtle,"digest");
  await reopened.prepare(ROOTFS_CHECKPOINT_URL,f.trusted,f.saved.rootfs.manifest.sha256,true,undefined,"before-ready");
  expect(hashing.mock.calls.filter(([,bytes])=>bytes.byteLength===f.bytes.length)).toHaveLength(1);
});

it("authenticates the selected manifest once per restore transaction and keeps existing manifest files",async()=>{
  const f=await installed(6),hashing=vi.spyOn(crypto.subtle,"verify");
  const file=f.root.directory("userspace-rootfs",false).directory("manifests",false).file(`${f.saved.rootfs.manifest.sha256}.json`,false);
  const writes=vi.spyOn(file,"createWritable"),destination={manifestUrl:ROOTFS_CHECKPOINT_URL,trusted:f.trusted};
  const retire=await f.source.beginCheckpointVerification();
  try {
    await f.source.prepareCheckpoint(OWNER,f.saved.rootfs,f.saved.manifest,destination);
    await f.source.acquireCheckpoint({...OWNER,snapshotId:crypto.randomUUID()},f.saved.rootfs,f.saved.manifest,destination,"restore");
    await f.source.activateCheckpoint(OWNER,f.trusted);
    expect(hashing).toHaveBeenCalledOnce();
    expect(writes).not.toHaveBeenCalled();
  }finally{retire();}
  const next=await f.source.beginCheckpointVerification();
  try {await f.source.prepareCheckpoint(OWNER,f.saved.rootfs,f.saved.manifest,destination);expect(hashing).toHaveBeenCalledTimes(2);}
  finally{next();}
});

it.each(["different-image", "incomplete"] as const)("rejects a %s global installation pin before new-workspace selection",async kind=>{
  const f=await installed(6),digest=f.saved.rootfs.manifest.sha256;
  const owner={workspaceId:`image:${digest}`,snapshotId:"00000000-0000-4000-8000-000000000001"};
  const pins=f.root.directory("userspace-rootfs",false).directory("pins",false);
  const name=async(value:typeof owner)=>`${await sha256Hex(new TextEncoder().encode(JSON.stringify([value.workspaceId,value.snapshotId])))}.json`;
  const pin=pins.file(await name(owner),false);
  if(kind==="different-image"){
    const other=await signedCheckpointRootfsFixture("another-image",6,Uint8Array.of(9),"bin",f.keys),second=store(f.root);
    await second.prepare(ROOTFS_CHECKPOINT_URL,other.trusted,undefined,false,undefined,"before-ready");
    await second.prepareImage(OWNER,new AbortController().signal,()=>{},"first-install");
    const otherOwner={...owner,workspaceId:`image:${await sha256Hex(other.bytes)}`};
    const encoded=record(JSON.parse(await (await pins.file(await name(otherOwner),false).getFile()).text()) as unknown,"other pin");
    pin.setBytes(new TextEncoder().encode(JSON.stringify({...encoded,owner})));
  }else{
    const encoded=record(JSON.parse(await (await pin.getFile()).text()) as unknown,"installation pin");
    pin.setBytes(new TextEncoder().encode(JSON.stringify({...encoded,version:2,closure:"image"})));
  }
  await expect(RootfsStore.inspectInstalledImage(f.root,digest,f.trusted)).rejects.toMatchObject({code:"STORAGE_ERROR"});
});
