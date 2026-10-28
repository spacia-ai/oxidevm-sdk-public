import { afterEach, expect, it, vi } from "vitest";
import { RootfsPackCache } from "./rootfs-pack-cache.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { signedCheckpointRootfsFixture, ROOTFS_CHECKPOINT_URL } from "./rootfs-checkpoint.test-support.js";
import { record } from "../decode.js";
import { decodeUserspaceRootfsManifest, rootfsClosure } from "../userspace-rootfs.js";
import { packRootfsContents } from "../userspace-rootfs-packing.js";
import { sha256Hex } from "./snapshot-content.js";
import { write } from "./rootfs-store-backend.js";
import type * as SHA2 from "@noble/hashes/sha2.js";
import * as storage from "./rootfs-store-backend.js";

const hashing=vi.hoisted(()=>vi.fn<()=>void>());
vi.mock("@noble/hashes/sha2.js",async importOriginal=>{
  const original=await importOriginal<typeof SHA2>();
  return {...original,sha256:Object.assign((bytes:Uint8Array)=>original.sha256(bytes),original.sha256,{create:()=>{hashing();return original.sha256.create();}})};
});

const ports:MessagePort[]=[];
afterEach(()=>{ports.splice(0).forEach(port=>port.close());vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(content = Uint8Array.of(1, 2, 3)) {
  const original=await signedCheckpointRootfsFixture("one",6,content),manifest=decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder().decode(original.bytes)) as unknown,new URL(ROOTFS_CHECKPOINT_URL));
  const encoded=new Map<string,Uint8Array<ArrayBuffer>>(),artifacts:{sha256:string;encoding:"gzip";url:string;encodedBytes:number;encodedSha256:string}[]=[];
  const index=await packRootfsContents(rootfsClosure(manifest),async function*(blob){yield await Promise.resolve(blob.sha256 === original.blobHash ? content : Uint8Array.of(4));},async(chunk,bytes)=>{
    const data=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const url=`./packs/${chunk.sha256}`;encoded.set(new URL(url,ROOTFS_CHECKPOINT_URL).href,data);
    artifacts.push({sha256:chunk.sha256,encoding:"gzip",url,encodedBytes:data.length,encodedSha256:await sha256Hex(data)});
  });
  const published=record(JSON.parse(new TextDecoder().decode(original.bytes)) as unknown,"signed fixture");
  const packed=decodeUserspaceRootfsManifest({...published,schemaVersion:8,packs:{index,artifacts}},new URL(ROOTFS_CHECKPOINT_URL));
  const fetcher=vi.fn<typeof fetch>(input=>{const data=encoded.get(input instanceof Request ? input.url : input instanceof URL ? input.href : input);return Promise.resolve(data===undefined?new Response("missing",{status:404}):new Response(data));});vi.stubGlobal("fetch",fetcher);
  const channel=new MessageChannel();ports.push(channel.port1,channel.port2);serveRootfsNetwork(channel.port1);
  const root=new MemoryDirectory(),backend={kind:"opfs" as const,root},network=new RootfsNetworkClient(channel.port2);
  return {packed,manifest,index,artifacts,encoded,fetcher,root,backend,network,cache:new RootfsPackCache(backend,network,(scope,name,bytes)=>write(backend,scope,name,bytes))};
}

it("reuses each new pack's verified readback during installation",async()=>{
  const f=await fixture(),reading=vi.spyOn(Blob.prototype,"arrayBuffer");
  expect(await f.cache.ensure(f.packed,"5".repeat(64))).toBe(true);
  const reads=reading.mock.contexts.filter((body:unknown)=>body instanceof File&&/^[0-9a-f]{64}$/u.test(body.name));
  expect(reads).toHaveLength(f.index.chunks.length);
});

it("parses a legacy layout once for repeated demand reads without treating its bodies as verified",async()=>{
  const f=await fixture(),digest="4".repeat(64);
  await f.cache.ensure(f.packed,digest);
  const file=f.root.find(`userspace-rootfs/pack-layouts/${digest}.json`);if(!(file instanceof MemoryFile))throw new Error("Missing layout");
  const opening=vi.spyOn(file,"getFile"),cache=new RootfsPackCache(f.backend);
  expect(await cache.available(f.manifest,digest)).toBe(true);
  for(const blob of rootfsClosure(f.manifest))expect(await cache.readBlob(f.manifest,digest,blob)).toBeDefined();
  expect(opening).toHaveBeenCalledOnce();
  expect(cache.verifiedLayout(digest)).toBe(false);
});

it("downloads a legacy transport once, publishes only verified packs and reopens offline", async () => {
  const f = await fixture(), digest = "9".repeat(64), base = new URL(ROOTFS_CHECKPOINT_URL);
  const url = new URL(`transport/${digest}/packs-v1.json`, base).href;
  f.encoded.set(url, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: digest, packs: { index: f.index, artifacts: f.artifacts } })));
  expect(await f.cache.discover(f.manifest, digest, base)).toBe(true);
  expect(await f.cache.index(f.manifest, digest)).toBeUndefined();
  expect(await f.cache.ensure(f.manifest, digest)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.root.find(`userspace-rootfs/blobs/${f.manifest.blobs[0]?.sha256 ?? ""}`)).toBeUndefined();
  const reopened = new RootfsPackCache(f.backend, f.network, (scope, name, bytes) => write(f.backend, scope, name, bytes));
  f.fetcher.mockClear();
  expect(await reopened.verify(f.manifest, digest)).toBe(true);
  expect(await reopened.discover(f.manifest, digest, base)).toBe(true);
  expect(await reopened.ensure(f.manifest, digest)).toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("retains a partial installation journal and downloads only missing packs after reopening", async () => {
  const f = await fixture(new Uint8Array(7 * 1024 ** 2).fill(7).fill(8, 4 * 1024 ** 2));
  const digest = "7".repeat(64), base = new URL(ROOTFS_CHECKPOINT_URL), missing = f.artifacts[1];
  if (missing === undefined) throw new Error("fixture requires two packs");
  f.encoded.set(new URL(`transport/${digest}/packs-v1.json`, base).href, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: digest, packs: { index: f.index, artifacts: f.artifacts } })));
  const body = f.encoded.get(new URL(missing.url, base).href);
  if (body === undefined) throw new Error("missing encoded fixture");
  f.encoded.delete(new URL(missing.url, base).href);
  await f.cache.discover(f.manifest, digest, base);
  await expect(f.cache.ensure(f.manifest, digest)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const intent = f.root.find(`userspace-rootfs/installations/${digest}.json`);
  if (!(intent instanceof MemoryFile)) throw new Error("missing installation intent");
  expect(JSON.parse(await (await intent.getFile()).text())).toMatchObject({ version: 1, manifestSHA256: digest, state: "installing" });
  expect(await f.cache.index(f.manifest, digest)).toBeUndefined();
  f.encoded.set(new URL(missing.url, base).href, body); f.fetcher.mockClear();
  const reopened = new RootfsPackCache(f.backend, f.network, (scope, name, bytes) => write(f.backend, scope, name, bytes));
  await reopened.discover(f.manifest, digest, base);
  expect(await reopened.ensure(f.manifest, digest)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(await (await intent.getFile()).text())).toMatchObject({ state: "installed" });
  await reopened.reclaim();
  expect(await reopened.verify(f.manifest, digest)).toBe(true);
});

it("never falls back to loose acquisition after invalid transport admission", async () => {
  const f = await fixture(), digest = "8".repeat(64), base = new URL(ROOTFS_CHECKPOINT_URL);
  f.encoded.set(new URL(`transport/${digest}/packs-v1.json`, base).href, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: "0".repeat(64), packs: { index: f.index, artifacts: f.artifacts } })));
  await expect(f.cache.discover(f.manifest, digest, base)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(await f.cache.index(f.manifest, digest)).toBeUndefined();
});

it("shares pack acquisition between concurrent preparation consumers", async () => {
  const f = await fixture(), digest = "6".repeat(64), base = new URL(ROOTFS_CHECKPOINT_URL);
  f.encoded.set(new URL(`transport/${digest}/packs-v1.json`, base).href, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: digest, packs: { index: f.index, artifacts: f.artifacts } })));
  await f.cache.discover(f.manifest, digest, base); f.fetcher.mockClear();
  await Promise.all([f.cache.ensure(f.manifest, digest), f.cache.ensure(f.manifest, digest)]);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("completes publication after cancellation between verified data and layout commit", async () => {
  const f = await fixture(), digest = "5".repeat(64), base = new URL(ROOTFS_CHECKPOINT_URL);
  f.encoded.set(new URL(`transport/${digest}/packs-v1.json`, base).href, new TextEncoder().encode(JSON.stringify({ version: 1, manifestSHA256: digest, packs: { index: f.index, artifacts: f.artifacts } })));
  let fail = true;
  const cache = new RootfsPackCache(f.backend, f.network, (scope, name, bytes) => {
    if (scope === "pack-layouts" && fail) return Promise.reject(new DOMException("quota", "QuotaExceededError"));
    return write(f.backend, scope, name, bytes);
  });
  await cache.discover(f.manifest, digest, base);
  await expect(cache.ensure(f.manifest, digest)).rejects.toThrow();
  fail = false; f.fetcher.mockClear();
  expect(await cache.ensure(f.manifest, digest)).toBe(true);
  expect(await cache.index(f.manifest, digest)).toBeDefined();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("acquires complete packed data without downloading loose blobs and reuses it offline",async()=>{
  const f=await fixture(),digest="a".repeat(64);
  await f.cache.ensure(f.packed,digest);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(await f.cache.readBlob(f.packed,digest,f.packed.blobs[0] ?? {sha256:"",bytes:0,url:new URL(ROOTFS_CHECKPOINT_URL)})).toEqual(Uint8Array.of(1,2,3));
  vi.stubGlobal("fetch",vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
  expect(await f.cache.verify(f.packed,digest)).toBe(true);
  const chunk=f.index.chunks[0];if(chunk===undefined)throw new Error("missing pack");
  const file=f.root.find(`userspace-rootfs/packs/${chunk.sha256}`);if(!(file instanceof MemoryFile))throw new Error("missing cache");
  file.setBytes(new Uint8Array(chunk.bytes).fill(9));
  expect(await f.cache.verify(f.packed,digest)).toBe(false);
});

it("builds an optional legacy accelerator and preserves all original cached objects",async()=>{
  const f=await fixture(),digest="b".repeat(64);
  for(const blob of rootfsClosure(f.manifest))await write(f.backend,"blobs",blob.sha256,blob.bytes===3?Uint8Array.of(1,2,3):Uint8Array.of(4));
  expect(await f.cache.compact(f.manifest,digest,new AbortController().signal)).toBe(true);
  expect(await f.cache.verify(f.manifest,digest)).toBe(true);
  for(const blob of rootfsClosure(f.manifest))expect(f.root.find(`userspace-rootfs/blobs/${blob.sha256}`)).toBeInstanceOf(MemoryFile);
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(f.cache.compact(f.manifest,digest,AbortSignal.abort())).rejects.toMatchObject({code:"ABORTED"});
});

it("retains an accelerator while a reader owns its file capability",async()=>{
  const f=await fixture(),digest="c".repeat(64);
  for(const blob of rootfsClosure(f.manifest))await write(f.backend,"blobs",blob.sha256,blob.bytes===3?Uint8Array.of(1,2,3):Uint8Array.of(4));
  await f.cache.compact(f.manifest,digest,new AbortController().signal);
  const blob=f.manifest.blobs[0];if(blob===undefined)throw new Error("missing file");
  const lease=await f.cache.openFile(f.manifest,digest,blob,new AbortController().signal,()=>{});
  if(lease===undefined)throw new Error("missing lease");
  await f.cache.reclaim();
  expect(await f.cache.index(f.manifest,digest)).toBeDefined();
  await lease.retire();await f.cache.reclaim();
  expect(await f.cache.index(f.manifest,digest)).toBeUndefined();
});

it("verifies each packed file once within a transaction and rechecks the next transaction",async()=>{
  const f=await fixture(),digest="d".repeat(64),signal=new AbortController().signal;
  await f.cache.ensure(f.packed,digest);
  hashing.mockClear();const cryptoHash=vi.spyOn(crypto.subtle,"digest"),retire=f.cache.beginVerification();
  expect(await f.cache.verify(f.packed,digest)).toBe(true);
  const checked=hashing.mock.calls.length+cryptoHash.mock.calls.length;
  for(const blob of f.packed.blobs){
    const lease=await f.cache.openFile(f.packed,digest,blob,signal,()=>{});
    expect(lease).toBeDefined();await lease?.retire();
  }
  expect(await f.cache.verify(f.packed,digest)).toBe(true);
  expect(hashing.mock.calls.length+cryptoHash.mock.calls.length).toBe(checked);
  retire();const retireNext=f.cache.beginVerification();
  expect(await f.cache.verify(f.packed,digest)).toBe(true);
  expect(hashing.mock.calls.length+cryptoHash.mock.calls.length).toBe(checked*2);
  retireNext();
});

it("does not share file verification between different extent layouts",async()=>{
  const f=await fixture(),digest="e".repeat(64);
  await f.cache.ensure(f.packed,digest);
  const retire=f.cache.beginVerification();expect(await f.cache.verify(f.packed,digest)).toBe(true);
  const evidence=f.index.blobs.find(blob=>blob.extents[0]?.bytes===1);
  if(evidence===undefined)throw new Error("missing evidence file");
  const packs=f.packed.packs;if(packs===undefined)throw new Error("missing packs");
  const changed={...f.packed,packs:{...packs,index:{...f.index,blobs:f.index.blobs.map(blob=>blob===evidence?{
    ...blob,extents:blob.extents.map(extent=>({...extent,offset:extent.offset===0?1:0})),
  }:blob)}}};
  expect(await f.cache.verify(changed,digest)).toBe(false);retire();
});

it("keeps verified file capabilities for admitted streams after the transaction retires",async()=>{
  const f=await fixture(),digest="a".repeat(64),signal=new AbortController().signal;
  await f.cache.ensure(f.packed,digest);
  const chunk=f.index.chunks[0],blob=f.packed.blobs[0];
  if(chunk===undefined||blob===undefined)throw new Error("missing packed fixture");
  const file=f.root.find(`userspace-rootfs/packs/${chunk.sha256}`);
  if(!(file instanceof MemoryFile))throw new Error("missing pack body");
  const retire=f.cache.beginVerification();
  expect(await f.cache.verify(f.packed,digest)).toBe(true);
  const lease=await f.cache.openFile(f.packed,digest,blob,signal,()=>{});
  if(lease?.snapshot===undefined)throw new Error("missing packed read lease");
  retire();
  const reopened=vi.spyOn(file,"getFile").mockRejectedValue(new DOMException("replacement is unreadable","NotReadableError"));
  const producer=lease.snapshot.source(signal);
  try {
    const frames:Uint8Array<ArrayBuffer>[]=[];
    for await(const frame of producer.frames)frames.push(frame);
    expect(frames).toEqual([Uint8Array.of(1,2,3)]);
    expect(reopened).not.toHaveBeenCalled();
  } finally {await producer.retire();await lease.retire();}
});

it("keeps an admitted stream's file capability separate from pending repair",async()=>{
  const f=await fixture(),digest="b".repeat(64),signal=new AbortController().signal;
  await f.cache.ensure(f.packed,digest);
  const chunk=f.index.chunks[0],blob=f.packed.blobs[0],artifact=f.artifacts[0];
  if(chunk===undefined||blob===undefined||artifact===undefined)throw new Error("missing packed fixture");
  const file=f.root.find(`userspace-rootfs/packs/${chunk.sha256}`);
  if(!(file instanceof MemoryFile))throw new Error("missing pack body");
  const admitted=await file.getFile();vi.spyOn(file,"getFile").mockResolvedValueOnce(admitted);
  const retire=f.cache.beginVerification(),lease=await f.cache.openFile(f.packed,digest,blob,signal,()=>{});
  if(lease?.snapshot===undefined)throw new Error("missing packed read lease");
  const failure=new DOMException("old snapshot is unreadable","NotReadableError");
  vi.spyOn(admitted,"arrayBuffer").mockRejectedValue(failure);vi.spyOn(admitted,"slice").mockImplementation(()=>{throw failure;});
  file.setBytes(new Uint8Array(chunk.bytes).fill(9));
  const downloading=Promise.withResolvers<undefined>(),resume=Promise.withResolvers<undefined>();
  const encoded=f.encoded.get(new URL(artifact.url,ROOTFS_CHECKPOINT_URL).href);
  if(encoded===undefined)throw new Error("missing encoded fixture");
  vi.spyOn(f.network,"fetchBlob").mockImplementation(async()=>{downloading.resolve(undefined);await resume.promise;return encoded;});
  const repair=f.cache.ensure(f.packed,digest);await downloading.promise;
  const producer=lease.snapshot.source(signal);
  try {
    await expect((async()=>{for await(const frame of producer.frames)void frame;})()).rejects.toBe(failure);
  }finally{
    await producer.retire();await lease.retire();resume.resolve(undefined);await repair;retire();
  }
});

it("requires whole-pack hashes after demand reads verified every logical file",async()=>{
  const f=await fixture(),digest="a".repeat(64),wrong="0".repeat(64);
  await f.cache.ensure(f.packed,digest);
  const chunk=f.index.chunks[0];if(chunk===undefined)throw new Error("missing pack");
  const file=f.root.find(`userspace-rootfs/packs/${chunk.sha256}`);if(!(file instanceof MemoryFile))throw new Error("missing pack body");
  await write(f.backend,"packs",wrong,new Uint8Array(await (await file.getFile()).arrayBuffer()));
  const packed={...f.packed,packs:{index:{...f.index,
    chunks:f.index.chunks.map(entry=>({...entry,sha256:wrong})),
    blobs:f.index.blobs.map(blob=>({...blob,extents:blob.extents.map(extent=>({...extent,chunk:wrong}))})),
  },artifacts:[]}};
  const cache=new RootfsPackCache(f.backend),retire=cache.beginVerification();
  try {
    for(const blob of rootfsClosure(packed))expect(await cache.readBlob(packed,digest,{...blob,url:new URL(ROOTFS_CHECKPOINT_URL)})).toBeDefined();
    expect(await cache.verify(packed,digest)).toBe(false);
  } finally {retire();}
});

it("reads a small installed file by its signed extents instead of rereading its complete pack",async()=>{
  const f=await multiplePacks(),blob=f.packed.blobs.find(blob=>blob.bytes===3);
  if(blob===undefined)throw new Error("missing small file");
  const reading=vi.spyOn(Blob.prototype,"arrayBuffer");
  const cache=new RootfsPackCache(f.backend);
  expect(await cache.readBlob(f.packed,"f".repeat(64),blob)).toEqual(Uint8Array.of(1,2,3));
  const readBytes=reading.mock.contexts.reduce<number>((sum,body:unknown)=>sum+(body instanceof Blob?body.size:0),0);
  expect(readBytes).toBe(3);
});

async function multiplePacks() {
  const f=await fixture(),contents=new Map(rootfsClosure(f.manifest).map(blob=>[blob.sha256,blob.bytes===3?Uint8Array.of(1,2,3):Uint8Array.of(4)]));
  const blobs=[...f.manifest.blobs];
  for(let byte=5;byte<8;byte++){
    const bytes=new Uint8Array(3*1024**2).fill(byte),sha256=await sha256Hex(bytes);
    contents.set(sha256,bytes);blobs.push({sha256,bytes:bytes.length,url:new URL(ROOTFS_CHECKPOINT_URL)});
  }
  const manifest={...f.manifest,blobs},bodies=new Map<string,Uint8Array<ArrayBuffer>>();
  const index=await packRootfsContents(rootfsClosure(manifest),async function*(blob){const bytes=contents.get(blob.sha256);if(bytes===undefined)throw new Error("missing file");yield await Promise.resolve(bytes);},async(chunk,bytes)=>{
    bodies.set(chunk.sha256,bytes);await write(f.backend,"packs",chunk.sha256,bytes);
  });
  const packed={...manifest,schemaVersion:8 as const,packs:{index,artifacts:[]}};
  return {...f,packed,index,bodies};
}

it("reads an already cached packed image only once during preparation",async()=>{
  const f=await multiplePacks(),reads=vi.spyOn(Blob.prototype,"arrayBuffer");
  expect(await f.cache.ensure(f.packed,"f".repeat(64))).toBe(true);
  expect(reads).toHaveBeenCalledTimes(f.index.chunks.length);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("rechecks evicted IndexedDB chunks before accepting complete image verification",async()=>{
  const f=await multiplePacks(),database=new Promise<IDBDatabase>(()=>{});
  const read=vi.spyOn(storage,"read").mockImplementation(async(_backend,scope,name)=>{await Promise.resolve();return scope==="packs"?f.bodies.get(name):undefined;});
  const cache=new RootfsPackCache({kind:"indexeddb",database}),retire=cache.beginVerification();
  expect(await cache.verify(f.packed,"1".repeat(64))).toBe(true);
  const evicted=f.index.chunks[0];if(evicted===undefined)throw new Error("missing pack");
  f.bodies.delete(evicted.sha256);read.mockClear();
  expect(await cache.verify(f.packed,"1".repeat(64))).toBe(false);
  expect(read).toHaveBeenCalled();retire();
});
