import { afterEach, expect, it, vi } from "vitest";
import { RootfsStore } from "./rootfs-store.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";
import { rootfsClosure, decodeUserspaceRootfsManifest, canonicalUserspaceRootfsBytes } from "../userspace-rootfs.js";
import { write } from "./rootfs-store-backend.js";
import { packRootfsContents } from "../userspace-rootfs-packing.js";
import { record } from "../decode.js";

import {ROOTFS_CHECKPOINT_URL as URL,signedCheckpointRootfsFixture as fixture} from "./rootfs-checkpoint.test-support.js";
const OWNER = { workspaceId: "workspace-a", snapshotId: "123e4567-e89b-42d3-a456-426614174001" };
const ports: MessagePort[] = [];

it("checks same-size installed image corruption on use without scanning unused data during capture", async () => {
  const data = await fixture("corrupt-installed", 6), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted, undefined, false, undefined, "before-ready");
  await source.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const baseline = await source.pinImage(OWNER);
  root.directory("userspace-rootfs", false).directory("blobs", false).file(data.blobHash, false).setBytes(Uint8Array.of(9, 2, 3));
  data.fetcher.mockClear();
  await expect(source.captureCheckpoint({ ...OWNER, snapshotId: "123e4567-e89b-42d3-a456-426614174002" }, undefined,
    { owner: OWNER, rootfs: baseline.rootfs })).resolves.toMatchObject({ rootfs: baseline.rootfs });
  await expect(source.read("bin/app")).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  expect(data.fetcher).not.toHaveBeenCalled();
});

it("keeps automatic preparation local when installation pins and a dependency disappear", async () => {
  const data = await fixture("automatic-local", 6), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted, undefined, false, undefined, "before-ready");
  await source.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const cache = root.directory("userspace-rootfs", false), pins = cache.directory("pins", false);
  for await (const name of pins.keys()) await pins.removeEntry(name);
  await cache.directory("blobs", false).removeEntry(data.blobHash); data.fetcher.mockClear();
  await expect(source.prepareImage(OWNER, new AbortController().signal, () => {}, "automatic"))
    .rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  expect(data.fetcher).not.toHaveBeenCalled();
});

it("repairs missing retained provenance before ready using the exact selected manifest", async () => {
  const data = await fixture("repair-retained", 6), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const manifestSHA256 = source.currentIdentity().manifestSHA256;
  await root.directory("userspace-rootfs", false).directory("blobs", false).removeEntry(await sha256Hex(Uint8Array.of(4)));
  const repaired = store(root);
  await expect(repaired.prepare(URL, data.trusted, manifestSHA256, true, undefined, "before-ready"))
    .resolves.toMatchObject({ version: "repair-retained" });
});

it("requires local reads after complete installation and repairs missing data explicitly", async () => {
  const data = await fixture("installed-local", 6), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted, undefined, false, undefined, "before-ready");
  await source.prepareImage(OWNER, new AbortController().signal, () => {}, "first-install");
  const baseline = await source.pinImage(OWNER);
  const blobs = root.directory("userspace-rootfs", false).directory("blobs", false);
  await blobs.removeEntry(data.blobHash); data.fetcher.mockClear();
  await expect(source.read("bin/app")).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  expect(data.fetcher).not.toHaveBeenCalled();
  await expect(source.captureCheckpoint({ ...OWNER, snapshotId: "123e4567-e89b-42d3-a456-426614174002" }, undefined,
    { owner: OWNER, rootfs: baseline.rootfs })).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "image-not-cached" } });
  await source.prepareImage(OWNER, new AbortController().signal, () => {}, "repair");
  expect((await source.read("bin/app")).bytes).toEqual(Uint8Array.of(1, 2, 3));
});
afterEach(() => { vi.unstubAllGlobals(); for (const port of ports.splice(0)) port.close(); });
function store(root: MemoryDirectory): RootfsStore {
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  return RootfsStore.opfs(root, new RootfsNetworkClient(channel.port1));
}

it("keeps unpublished transport packs reachable through another worker's collection", async () => {
  const data = await fixture("transport-gc", 6), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const digest = await sha256Hex(data.bytes), base = new globalThis.URL(URL);
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(data.bytes)) as unknown, base);
  const encoded = new Map<string, Uint8Array<ArrayBuffer>>(), artifacts: { sha256: string; encoding: "gzip"; url: string; encodedBytes: number; encodedSha256: string }[] = [];
  const index = await packRootfsContents(rootfsClosure(manifest), async function*(blob) {
    yield await Promise.resolve(blob.sha256 === data.blobHash ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4));
  }, async (chunk, body) => {
    const compressed = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const url = `./packs/${chunk.sha256}`; encoded.set(new globalThis.URL(url, base).href, compressed);
    artifacts.push({ sha256: chunk.sha256, encoding: "gzip", url, encodedBytes: compressed.length, encodedSha256: await sha256Hex(compressed) });
  });
  encoded.set(new globalThis.URL(`transport/${digest}/packs-v1.json`, base).href, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: digest, packs: { index, artifacts } })));
  const get = vi.fn((url: string) => encoded.has(url) ? Promise.resolve(new Response(encoded.get(url))) : data.fetcher(url));
  vi.stubGlobal("fetch", get);
  const layout = root.directory("userspace-rootfs", true).directory("pack-layouts", true).file(`${digest}.json`, true);
  vi.spyOn(layout, "createWritable").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
  await expect(source.prepareImage(OWNER, new AbortController().signal, () => {})).rejects.toThrow();
  const chunk = index.chunks[0]; if (chunk === undefined) throw new Error("missing fixture chunk");
  const stored = root.find(`userspace-rootfs/packs/${chunk.sha256}`);
  await store(root).collect();
  expect(root.find(`userspace-rootfs/packs/${chunk.sha256}`)).toBe(stored);
  get.mockClear();
  await source.prepareImage(OWNER, new AbortController().signal, () => {});
  expect(get).not.toHaveBeenCalled();
});

it("serializes shared image installation across workspace storage workers", async () => {
  const data = await fixture("shared-install", 8), root = new MemoryDirectory(), first = store(root), second = store(root);
  await first.prepare(URL, data.trusted); await second.prepare(URL, data.trusted);
  const tails = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", { locks: { request: (name: string, options: { mode?: string }, run: () => Promise<void>) => {
    if (options.mode === "shared") return run();
    const pending = (tails.get(name) ?? Promise.resolve()).then(run);
    tails.set(name, pending.catch(() => {})); return pending;
  } } });
  data.fetcher.mockClear();
  await Promise.all([first.prepareImage(OWNER, new AbortController().signal, () => {}), second.prepareImage({ ...OWNER, workspaceId: "workspace-b" }, new AbortController().signal, () => {})]);
  expect(data.fetcher.mock.calls.filter(([url]) => url.includes("/packs/"))).toHaveLength(1);
});
it("shares background acquisition with a guest demand read and cancels only the save's interest",async()=>{
  const data=await fixture(),root=new MemoryDirectory(),source=store(root);
  await source.prepare(URL,data.trusted);
  const entered=Promise.withResolvers<undefined>(),unblock=Promise.withResolvers<undefined>();
  const original=data.fetcher;
  const fetcher=vi.fn(async(url:string)=>{if(url.endsWith("/unread")){entered.resolve(undefined);await unblock.promise;}return original(url);});vi.stubGlobal("fetch",fetcher);
  const controller=new AbortController(),saving=source.captureCheckpoint(OWNER,undefined,undefined,controller.signal);
  const cancelled=expect(saving).rejects.toMatchObject({code:"ABORTED"});
  await entered.promise;
  const demand=source.read("bin/app");
  await new Promise(resolve=>setTimeout(resolve,20));
  controller.abort();unblock.resolve(undefined);
  expect((await demand).bytes).toEqual(Uint8Array.of(1,2,3));await cancelled;
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith("/unread"))).toHaveLength(1);
});

it("saves a schema-8 image offline when its complete loose closure is already cached", async () => {
  const data = await fixture("packed-loose", 8), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(data.bytes)) as unknown, new globalThis.URL(URL));
  for (const blob of rootfsClosure(manifest)) {
    await write({ kind: "opfs", root }, "blobs", blob.sha256, blob.sha256 === data.blobHash ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4));
  }
  const offline=vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));vi.stubGlobal("fetch",offline);
  await expect(source.captureCheckpoint(OWNER)).resolves.toMatchObject({ rootfs: { image: { version: "packed-loose" } } });
  expect(offline).not.toHaveBeenCalled();
  const name=await sha256Hex(new TextEncoder().encode(JSON.stringify([OWNER.workspaceId,OWNER.snapshotId])));
  const pin=root.find(`userspace-rootfs/pins/${name}.json`);if(!(pin instanceof MemoryFile))throw new Error("missing pin");
  expect(JSON.parse(await (await pin.getFile()).text()) as unknown).toMatchObject({version:2,closure:"complete"});
});

it("rechecks every signed pack after reopening without rehashing its previously verified file layout",async()=>{
  const content=new Uint8Array(1024**2+1).fill(7),data=await fixture("verified-packs",8,content),root=new MemoryDirectory(),source=store(root);
  await source.prepare(URL,data.trusted);const saved=await source.captureCheckpoint(OWNER);
  const next={...OWNER,snapshotId:crypto.randomUUID()};await source.captureCheckpoint(next,undefined,{owner:OWNER,rootfs:saved.rootfs});
  await source.releaseCheckpoint(OWNER);
  const hashing=vi.spyOn(crypto.subtle,"digest");
  const destination=store(root);await destination.activateCheckpoint(next,data.trusted);
  expect(hashing.mock.calls.filter(([,bytes])=>bytes.byteLength===content.length)).toHaveLength(0);
  expect(hashing.mock.calls.filter(([,bytes])=>bytes.byteLength===content.length+1)).toHaveLength(1);
  const packs=root.find("userspace-rootfs/packs");if(!(packs instanceof MemoryDirectory))throw new Error("missing packs");
  const file=packs.find(packs.names()[0]??"");if(!(file instanceof MemoryFile))throw new Error("missing pack");
  file.setBytes(new Uint8Array(content.length+1).fill(9));
  vi.stubGlobal("fetch",vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
  await expect(store(root).activateCheckpoint(next,data.trusted)).rejects.toThrow();
});

it("does not authorize an unverified signed pack layout through a complete loose pin",async()=>{
  const data=await fixture("wrong-layout",8),root=new MemoryDirectory(),backend={kind:"opfs" as const,root};
  const value=JSON.parse(new TextDecoder().decode(data.bytes)) as unknown;
  const manifest=decodeUserspaceRootfsManifest(value,new globalThis.URL(URL)),packs=manifest.packs;
  if(packs===undefined)throw new Error("missing packs");
  const changed={...manifest,packs:{...packs,index:{...packs.index,blobs:packs.index.blobs.map(blob=>({...blob,extents:blob.extents.map(extent=>({...extent,offset:extent.offset===0?1:0}))}))}}};
  const signature=new Uint8Array(await crypto.subtle.sign("Ed25519",data.keys.privateKey,canonicalUserspaceRootfsBytes(changed)));
  // Keep URL literals from the signed fixture when serializing the new manifest.
  const encoded=record(value,"rootfs fixture"),provenance=record(encoded["provenance"],"fixture provenance"),encodedPacks=record(encoded["packs"],"fixture packs");
  const bytes=new TextEncoder().encode(JSON.stringify({...encoded,packs:{...encodedPacks,index:changed.packs.index},provenance:{...provenance,signature:btoa(String.fromCharCode(...signature)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"")}}));
  vi.stubGlobal("fetch",vi.fn<typeof fetch>(input=>data.fetcher(input instanceof Request?input.url:input instanceof globalThis.URL?input.href:input).then(response=>input===URL?new Response(bytes):response)));
  for(const blob of rootfsClosure(manifest))await write(backend,"blobs",blob.sha256,blob.sha256===data.blobHash?Uint8Array.of(1,2,3):Uint8Array.of(4));
  await packRootfsContents(rootfsClosure(manifest),async function*(blob){yield await Promise.resolve(blob.sha256===data.blobHash?Uint8Array.of(1,2,3):Uint8Array.of(4));},(chunk,body)=>write(backend,"packs",chunk.sha256,body));
  const source=store(root);await source.prepare(URL,data.trusted);await source.captureCheckpoint(OWNER);
  const blobs=await (await root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("blobs");for await(const name of blobs.keys())await blobs.removeEntry(name);
  vi.stubGlobal("fetch",vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
  await expect(store(root).activateCheckpoint(OWNER,data.trusted)).rejects.toThrow();
});

it.each([false, true])("does not publish a pin after its owner is released (cancel=%s)", async cancel => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  await source.pinImage(OWNER);
  const pinName=await sha256Hex(new TextEncoder().encode(JSON.stringify([OWNER.workspaceId,OWNER.snapshotId])));
  const file = root.find(`userspace-rootfs/pins/${pinName}.json`);
  if (!(file instanceof MemoryFile)) throw new Error("missing pin");
  const entered = Promise.withResolvers<undefined>(), unblock = Promise.withResolvers<undefined>();
  const create = file.createWritable.bind(file);
  vi.spyOn(file, "createWritable").mockImplementationOnce(async options => {
    entered.resolve(undefined); await unblock.promise; return create(options);
  });
  const controller = new AbortController();
  const preparing = source.prepareImage(OWNER, controller.signal, () => {});
  const rejected = expect(preparing).rejects.toMatchObject({ code: "ABORTED" });
  await entered.promise;
  const released = source.releaseCheckpoint(OWNER);
  if (cancel) controller.abort();
  unblock.resolve(undefined);
  await Promise.all([rejected, released]);
  const pins = await (await root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("pins");
  const names:string[]=[];for await(const name of pins.keys())names.push(name);
  expect(names).toEqual([]);
});

it("keeps unpublished legacy packs out of another workspace's garbage collection",async()=>{
  const data=await fixture("legacy",6),root=new MemoryDirectory(),source=store(root);
  await source.prepare(URL,data.trusted);await source.captureCheckpoint(OWNER);
  const manifest=decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(data.bytes)) as unknown,new globalThis.URL(URL));
  let digest="";
  await packRootfsContents(rootfsClosure(manifest),async function*(blob){yield await Promise.resolve(blob.sha256===data.blobHash?Uint8Array.of(1,2,3):Uint8Array.of(4));},async(chunk,bytes)=>{digest=chunk.sha256;await write({kind:"opfs",root},"packs",digest,bytes);});
  const file=root.find(`userspace-rootfs/packs/${digest}`);if(!(file instanceof MemoryFile))throw new Error("missing pack");
  const entered=Promise.withResolvers<undefined>(),unblock=Promise.withResolvers<undefined>(),create=file.createWritable.bind(file);
  vi.spyOn(file,"createWritable").mockImplementationOnce(async options=>{entered.resolve(undefined);await unblock.promise;return create(options);});
  let shared=0;
  vi.stubGlobal("navigator",{
    storage:{estimate:()=>Promise.resolve({usage:0,quota:8*1024**3})},
    locks:{request:async(name:string,options:LockOptions,callback:(lock:object|null)=>Promise<unknown>)=>{
      const lifecycle=name==="oxidevm-rootfs-pack-lifecycle";
      if(lifecycle&&options.mode==="exclusive"&&options.ifAvailable===true&&shared!==0)return callback(null);
      if(lifecycle&&options.mode==="shared")shared++;
      try{return await callback({name});}finally{if(lifecycle&&options.mode==="shared")shared--;}
    }},
  });
  const compacting=source.compactImage(new AbortController().signal);
  await entered.promise;
  try {await store(root).collect();expect(root.find(`userspace-rootfs/packs/${digest}`)).toBe(file);}
  finally {unblock.resolve(undefined);await compacting;}
});

it("pins schema-8 packs, keeps them reachable through GC and restores without loose image files", async () => {
  const data=await fixture("packed",8),root=new MemoryDirectory(),source=store(root);
  await source.prepare(URL,data.trusted);await source.captureCheckpoint(OWNER);
  expect(data.fetcher.mock.calls.filter(([url])=>url.endsWith("/unread"))).toHaveLength(0);
  const blobDirectory=await (await root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("blobs");
  for await(const name of blobDirectory.keys())await blobDirectory.removeEntry(name);
  await source.collect();
  vi.stubGlobal("fetch",vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
  const destination=store(root);await destination.activateCheckpoint(OWNER,data.trusted);
  expect((await destination.read("bin/app")).bytes).toEqual(Uint8Array.of(1,2,3));
  await expect(destination.prepare(URL,data.trusted,await sha256Hex(data.bytes),true)).resolves.toMatchObject({version:"packed"});
});

it("inherits a complete immutable closure pin without rereading bodies and still verifies restore", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER), next = { ...OWNER, snapshotId: crypto.randomUUID() };
  const body = root.find(`userspace-rootfs/blobs/${data.blobHash}`);
  if (!(body instanceof MemoryFile)) throw new Error("missing body");
  const reads = vi.spyOn(body, "getFile");
  await source.captureCheckpoint(next, undefined, { owner: OWNER, rootfs: saved.rootfs });
  expect(reads).not.toHaveBeenCalled();
  await source.releaseCheckpoint(OWNER);
  const destination = store(root); await destination.collect();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  await destination.activateCheckpoint(next, data.trusted);
  expect(reads).toHaveBeenCalledOnce();
  body.setBytes(new Uint8Array([9, 9, 9]));
  await expect(destination.activateCheckpoint(next, data.trusted)).rejects.toThrow();
  expect(reads).toHaveBeenCalledTimes(2);
});

it("distinguishes image-only pins from complete checkpoint closures", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const image = await source.pinImage(OWNER);
  const name = await sha256Hex(new TextEncoder().encode(JSON.stringify([OWNER.workspaceId, OWNER.snapshotId])));
  const pin = root.find(`userspace-rootfs/pins/${name}.json`);
  if (!(pin instanceof MemoryFile)) throw new Error("missing pin");
  const encoded: unknown = JSON.parse(await (await pin.getFile()).text());
  expect(encoded).toMatchObject({ version: 2, closure: "image" });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  await expect(source.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, undefined, { owner: OWNER, rootfs: image.rootfs })).rejects.toThrow();
});

it("rechecks legacy pins before promoting them to complete closure pins", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER);
  const name = await sha256Hex(new TextEncoder().encode(JSON.stringify([OWNER.workspaceId, OWNER.snapshotId])));
  const pin = root.find(`userspace-rootfs/pins/${name}.json`), body = root.find(`userspace-rootfs/blobs/${data.blobHash}`);
  if (!(pin instanceof MemoryFile) || !(body instanceof MemoryFile)) throw new Error("missing fixture");
  pin.setBytes(new TextEncoder().encode(JSON.stringify({version:1,owner:OWNER,sha256:saved.rootfs.manifest.sha256,bytes:saved.rootfs.manifest.bytes,manifestUrl:URL})));
  const reads = vi.spyOn(body, "getFile"), next = { ...OWNER, snapshotId: crypto.randomUUID() };
  await source.captureCheckpoint(next, undefined, { owner: OWNER, rootfs: saved.rootfs });
  expect(reads).toHaveBeenCalledOnce();
  reads.mockClear();
  await source.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, undefined, { owner: next, rootfs: saved.rootfs });
  expect(reads).not.toHaveBeenCalled();
});

it("rechecks the closure when the prior pin has been removed", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER);
  await source.releaseCheckpoint(OWNER);
  const body = root.find(`userspace-rootfs/blobs/${data.blobHash}`);
  if (!(body instanceof MemoryFile)) throw new Error("missing body");
  const reads = vi.spyOn(body, "getFile");
  await source.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, undefined, { owner: OWNER, rootfs: saved.rootfs });
  expect(reads).toHaveBeenCalledOnce();
});

it.each([{version:2,closure:"partial"},{version:3,closure:"complete"},{version:1,closure:"complete"}])("rejects invalid or future closure records %j", async fields => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER);
  const name = await sha256Hex(new TextEncoder().encode(JSON.stringify([OWNER.workspaceId, OWNER.snapshotId])));
  const pin = root.find(`userspace-rootfs/pins/${name}.json`);
  if (!(pin instanceof MemoryFile)) throw new Error("missing pin");
  pin.setBytes(new TextEncoder().encode(JSON.stringify({...fields,owner:OWNER,sha256:saved.rootfs.manifest.sha256,bytes:saved.rootfs.manifest.bytes,manifestUrl:URL})));
  await expect(source.activateCheckpoint(OWNER, data.trusted)).rejects.toThrow();
});

it("verifies immutable bodies once across a restore transaction and rechecks the next transaction", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER);
  const body = root.find(`userspace-rootfs/blobs/${data.blobHash}`);
  if (!(body instanceof MemoryFile)) throw new Error("missing body");
  const reads = vi.spyOn(body, "getFile");
  const retire = await source.beginCheckpointVerification();
  try {
    await source.prepareCheckpoint(OWNER, saved.rootfs, saved.manifest, { manifestUrl: URL, trusted: data.trusted });
    await source.captureCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() });
    await source.acquireCheckpoint({ ...OWNER, snapshotId: crypto.randomUUID() }, saved.rootfs, saved.manifest, { manifestUrl: URL, trusted: data.trusted });
    await source.activateCheckpoint(OWNER, data.trusted);
    expect(reads).toHaveBeenCalledOnce();
  } finally { retire(); }
  body.setBytes(new Uint8Array([9, 9, 9]));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  const next = await source.beginCheckpointVerification();
  try { await expect(source.activateCheckpoint(OWNER, data.trusted)).rejects.toThrow(); }
  finally { next(); }
  expect(reads).toHaveBeenCalledTimes(2);
});

it("finishes an already verified publication after late cancellation without another body read", async () => {
  const data = await fixture(), root = new MemoryDirectory(), source = store(root);
  await source.prepare(URL, data.trusted);
  const saved = await source.captureCheckpoint(OWNER);
  const abort = new AbortController(), retire = await source.beginCheckpointVerification(abort.signal);
  try {
    await source.prepareCheckpoint(OWNER, saved.rootfs, saved.manifest, { manifestUrl: URL, trusted: data.trusted });
    abort.abort();
    await expect(source.activateCheckpoint(OWNER, data.trusted)).resolves.toMatchObject({ rootTreeSha256: saved.rootfs.rootTreeSha256 });
  } finally { retire(); }
});

it("pins unread immutable files and resumes the captured closure entirely offline", async () => {
  const fixtureData = await fixture();
  const root = new MemoryDirectory("root");
  const source = store(root);
  await source.prepare(URL, fixtureData.trusted);
  expect(await source.cachedBlob(fixtureData.blobHash, 3)).toBeUndefined();
  const progress = vi.fn<(completedObjects: number) => void>();
  const captured = await source.captureCheckpoint(OWNER, progress);
  expect(progress.mock.calls.map(([completed]) => completed)).toEqual([1, 2, 3, 4, 5]);
  expect(captured.manifest).toEqual(fixtureData.bytes);
  expect(captured.rootfs.manifest).toEqual({ sha256: await sha256Hex(fixtureData.bytes), bytes: fixtureData.bytes.length });
  expect(await source.cachedBlob(fixtureData.blobHash, 3)).toEqual(new Uint8Array([1, 2, 3]));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  const destination = store(root);
  await destination.acquireCheckpoint(OWNER, captured.rootfs, captured.manifest, { manifestUrl: URL, trusted: fixtureData.trusted });
  expect(await destination.cachedCheckpointIdentities()).toContain(captured.rootfs.rootTreeSha256);
  await destination.activateCheckpoint(OWNER, fixtureData.trusted);
  expect((await destination.read("/bin/app")).bytes).toEqual(new Uint8Array([1, 2, 3]));
});

it("refuses incomplete or tampered closures before activation and keeps workspace pins distinct", async () => {
  const fixtureData = await fixture();
  const source = store(new MemoryDirectory("source"));
  await source.prepare(URL, fixtureData.trusted);
  const captured = await source.captureCheckpoint(OWNER);
  const root = new MemoryDirectory("destination");
  const destination = store(root);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  await expect(destination.acquireCheckpoint(OWNER, captured.rootfs, captured.manifest, { manifestUrl: URL, trusted: fixtureData.trusted })).rejects.toThrow();
  await expect(destination.read("/bin/app")).rejects.toThrow(/no Userspace rootfs/u);
  const tampered = captured.manifest.slice(); tampered[0] = 0;
  await expect(destination.acquireCheckpoint(OWNER, captured.rootfs, tampered, { manifestUrl: URL, trusted: fixtureData.trusted })).rejects.toThrow();
  vi.stubGlobal("fetch", fixtureData.fetcher);
  await destination.acquireCheckpoint(OWNER, captured.rootfs, captured.manifest, { manifestUrl: URL, trusted: fixtureData.trusted });
  const second = { ...OWNER, workspaceId: "workspace-b" };
  await destination.acquireCheckpoint(second, captured.rootfs, captured.manifest, { manifestUrl: URL, trusted: fixtureData.trusted });
  await destination.releaseCheckpoint(OWNER);
  await destination.collect();
  expect(await destination.cachedBlob(fixtureData.blobHash, 3)).toBeDefined();
  await destination.releaseCheckpoint(second);
  await destination.collect();
  expect(await destination.cachedBlob(fixtureData.blobHash, 3)).toBeUndefined();
});

it("rejects corrupt cached closure offline without switching the selected rootfs", async () => {
  const fixtureData = await fixture();
  const root = new MemoryDirectory("root");
  const destination = store(root);
  await destination.prepare(URL, fixtureData.trusted);
  const captured = await destination.captureCheckpoint(OWNER);
  const corrupted = root.find(`userspace-rootfs/blobs/${fixtureData.blobHash}`);
  if (!(corrupted instanceof MemoryFile)) throw new Error("missing cached blob");
  corrupted.setBytes(new Uint8Array([9, 9, 9]));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  expect(await destination.cachedCheckpointIdentities()).not.toContain(captured.rootfs.rootTreeSha256);
  await expect(destination.activateCheckpoint(OWNER, fixtureData.trusted)).rejects.toThrow();
  // Prepare state is still selected; failure is an unavailable blob, never an empty replacement.
  await expect(destination.read("/bin/app")).rejects.toThrow("offline");
});

it("verifies imported signatures before fetching and conservatively retains damaged pin reachability", async () => {
  const fixtureData = await fixture();
  const source = store(new MemoryDirectory("source"));
  await source.prepare(URL, fixtureData.trusted);
  const captured = await source.captureCheckpoint(OWNER);
  const root = new MemoryDirectory("root");
  const destination = store(root);
  fixtureData.fetcher.mockClear();
  await expect(destination.acquireCheckpoint(OWNER, captured.rootfs, captured.manifest, {
    manifestUrl: URL, trusted: { ...fixtureData.trusted, keyId: "wrong" },
  })).rejects.toThrow();
  expect(fixtureData.fetcher).not.toHaveBeenCalled();
  await destination.acquireCheckpoint(OWNER, captured.rootfs, captured.manifest, { manifestUrl: URL, trusted: fixtureData.trusted });
  const pins = root.find("userspace-rootfs/pins");
  if (!(pins instanceof MemoryDirectory)) throw new Error("missing pins");
  const pinName = pins.names()[0];
  if (pinName === undefined) throw new Error("missing pin");
  const pin = pins.find(pinName);
  if (!(pin instanceof MemoryFile)) throw new Error("missing pin data");
  pin.setBytes(new TextEncoder().encode("{"));
  await expect(destination.inspectCheckpoint(OWNER, fixtureData.trusted)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await destination.collect();
  expect(await destination.cachedBlob(fixtureData.blobHash, 3)).toBeDefined();
});

it("inspects a signed complete checkpoint without fetching, activating or repairing cached bytes", async () => {
  const data = await fixture(), root = new MemoryDirectory("root"), source = store(root);
  await source.prepare(URL, data.trusted); await source.captureCheckpoint(OWNER);
  const destination = store(root), fetcher = vi.fn(() => Promise.reject(new Error("unexpected fetch")));
  vi.stubGlobal("fetch", fetcher);
  expect(await destination.inspectCheckpoint({ ...OWNER, workspaceId: "absent" }, data.trusted)).toBeUndefined();
  expect((await RootfsStore.inspectCachedCheckpoint(root, OWNER, data.trusted))?.bytes).toEqual(data.bytes);
  await expect(destination.read("/bin/app")).rejects.toThrow(/no Userspace rootfs/u);
  const corrupted = root.find(`userspace-rootfs/blobs/${data.blobHash}`);
  if (!(corrupted instanceof MemoryFile)) throw new Error("missing cached blob");
  corrupted.setBytes(new Uint8Array([9]));
  await expect(destination.inspectCheckpoint(OWNER, data.trusted)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("offers only a cached authenticated requested image without activation or a network read",async()=>{
 const f=await fixture("requested",6),root=new MemoryDirectory("root"),source=store(root);
 await source.prepare(URL,f.trusted);
 const active=source.currentIdentity(),fetcher=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",fetcher);
 expect(await RootfsStore.inspectCachedImage(root,URL,f.trusted,await sha256Hex(f.bytes))).toEqual(active);
 expect(await RootfsStore.inspectCachedImage(root,"https://absent.test/manifest.json",f.trusted)).toBeUndefined();
 expect(source.currentIdentity()).toEqual(active);expect(fetcher).not.toHaveBeenCalled();
 const bad=f.trusted.publicKey.slice();bad[0]=(bad[0]??0)^1;
 expect(await RootfsStore.inspectCachedImage(root,URL,{...f.trusted,publicKey:bad},await sha256Hex(f.bytes))).toBeUndefined();
});


it("reads an unpublished older image source without activating it or reading the running image",async()=>{
 const old=await fixture("old",6),root=new MemoryDirectory("root"),source=store(root);
 await source.prepare(URL,old.trusted);const saved=await source.captureCheckpoint(OWNER);
 const current=await fixture("current",6,new Uint8Array([9,8,7]));await source.prepare(URL,current.trusted);
 const identity=source.currentIdentity();expect(identity.version).toBe("current");
 vi.stubGlobal("fetch",vi.fn(()=>Promise.reject(new Error("offline"))));
 await source.prepareCheckpoint(OWNER,saved.rootfs,saved.manifest,{manifestUrl:URL,trusted:old.trusted});
 const signal=new AbortController().signal;
 await expect(source.openCachedFile("/bin/app",old.blobHash,3,signal)).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
 await expect(source.openCachedFile("/bin/app",old.blobHash,3,signal,"123e4567-e89b-42d3-a456-426614174099")).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
 const lease=await source.openCachedFile("/bin/app",old.blobHash,3,signal,OWNER.snapshotId);
 if(lease.snapshot===undefined)throw new Error("missing immutable source");
 const reader=lease.snapshot.source(signal),frames:Uint8Array[]=[];for await(const frame of reader.frames)frames.push(frame);await reader.retire();await lease.retire();
 expect(frames).toEqual([new Uint8Array([1,2,3])]);expect(source.currentIdentity()).toEqual(identity);
});


it("admits exact cached foreign workspace base metadata and file bodies without activation",async()=>{
 const old=await fixture("old",6,new Uint8Array([1,2,3]),"workspace"),root=new MemoryDirectory("root"),source=store(root);
 const earlier=await source.prepare(URL,old.trusted),saved=await source.captureCheckpoint(OWNER);
 const now=await fixture("current",6,new Uint8Array([9,8,7]),"workspace");await source.prepare(URL,now.trusted);
 await source.prepareCheckpoint(OWNER,saved.rootfs,saved.manifest,{manifestUrl:URL,trusted:old.trusted});
 const base=earlier.workspaceBaseSha256;if(base===undefined)throw new Error("missing base");const active=source.currentIdentity();
 expect(await source.workspaceBaseMetadata(base)).toEqual({metadata:earlier.metadata});
 expect(await source.workspaceBaseMetadata("e".repeat(64))).toBeUndefined();
 await source.workspaceBaseMetadata(base);
 const signal=new AbortController().signal;await expect(source.openWorkspaceBaseFile(base,"/workspace/app",now.blobHash,3,signal)).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
 const lease=await source.openWorkspaceBaseFile(base,"/workspace/app",old.blobHash,3,signal);
 // Remove the older legacy cache marker so this read lease is its sole closure owner.
 const manifests=await (await root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("manifests");
 await manifests.removeEntry(`${earlier.rootTreeSha256}.${earlier.id}.${earlier.version}.json`);
 await source.releaseCheckpoint(OWNER);await source.collect();expect(await source.cachedBlob(old.blobHash,3)).toBeDefined();
 if(lease.snapshot===undefined)throw new Error("missing body");const reader=lease.snapshot.source(signal),frames:Uint8Array[]=[];
 for await(const bytes of reader.frames)frames.push(bytes);await reader.retire();await lease.retire();
 expect(frames).toEqual([new Uint8Array([1,2,3])]);expect(source.currentIdentity()).toEqual(active);
 await source.collect();expect(await source.cachedBlob(old.blobHash,3)).toBeUndefined();
});

it("pins a cold image identity without downloading unread files while full checkpoints require closure",async()=>{
 const f=await fixture("cold",6),root=new MemoryDirectory("root"),source=store(root);await source.prepare(URL,f.trusted);
 const fetched=f.fetcher.mock.calls.length;const selected=await source.pinImage(OWNER);expect(selected.manifest).toEqual(f.bytes);
 expect(f.fetcher.mock.calls.length).toBe(fetched);expect(await source.cachedBlob(f.blobHash,3)).toBeUndefined();
 vi.stubGlobal("fetch",vi.fn(()=>Promise.reject(new Error("offline"))));
 expect((await RootfsStore.inspectCachedImagePin(root,OWNER,f.trusted))?.manifest.version).toBe("cold");
 await expect(RootfsStore.inspectCachedCheckpoint(root,OWNER,f.trusted)).rejects.toMatchObject({code:"STORAGE_ERROR"});
 await expect(source.captureCheckpoint(OWNER)).rejects.toThrow("offline");
});

it("admits a cached foreign base for cold startup and retires that source without a checkpoint",async()=>{
 const old=await fixture("old-cold",6,new Uint8Array([1,2,3]),"workspace"),root=new MemoryDirectory("root"),source=store(root);
 const earlier=await source.prepare(URL,old.trusted);await source.read("/workspace/app");
 const next=await fixture("next-cold",6,new Uint8Array([4,5,6]),"workspace");await source.prepare(URL,next.trusted);
 const base=earlier.workspaceBaseSha256;if(base===undefined)throw new Error("missing old base");
 const fetcher=vi.fn(()=>Promise.reject(new Error("offline")));vi.stubGlobal("fetch",fetcher);
 expect(await source.workspaceBaseMetadata(base)).toEqual({metadata:earlier.metadata});
 const manifests=await (await root.getDirectoryHandle("userspace-rootfs")).getDirectoryHandle("manifests");
 await manifests.removeEntry(`${earlier.rootTreeSha256}.${earlier.id}.${earlier.version}.json`);
 await source.collect();expect(await source.cachedBlob(old.blobHash,3)).toBeDefined();
 source.retireWorkspaceBase();await source.collect();expect(await source.cachedBlob(old.blobHash,3)).toBeUndefined();
 expect(source.currentIdentity().version).toBe("next-cold");expect(fetcher).not.toHaveBeenCalled();
});
