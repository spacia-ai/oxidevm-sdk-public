import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { buildRootfsPacks, packImage, rootfsPackOrder } from "./rootfs-packs.js";
import { generateImageKey } from "./keys.js";
import { buildImage } from "./build.js";
import { hash } from "./files.js";
import { decodeRootfsPackIndex, ROOTFS_PACK_BYTES } from "../runtime/userspace-rootfs-packs.js";
import { decodeUserspaceRootfsManifest, rootfsClosure } from "../runtime/userspace-rootfs.js";

it("writes deterministic compressed packs for every immutable image dependency", async () => {
  const root=await mkdtemp(join(tmpdir(),"oxidevm-rootfs-packs-"));
  try {
    await mkdir(join(root,"blobs")); await mkdir(join(root,"evidence"));
    const file=Uint8Array.of(1,2,3),evidence=Uint8Array.of(4);
    await writeFile(join(root,"blobs",hash(file)),file);await writeFile(join(root,"evidence","proof"),evidence);
    const blob={bytes:file.length,sha256:hash(file),url:`./blobs/${hash(file)}`},proof={bytes:evidence.length,sha256:hash(evidence),url:"./evidence/proof"};
    const manifest={schemaVersion:3,kind:"linux-user-rootfs",id:"test",version:"one",architecture:"x86_64",cpuProfile:"x86-64-v2",sourceDateEpoch:0,
      rootTreeSha256:"a".repeat(64),workspaceBaseSha256:"b".repeat(64),fileCount:1,totalBytes:3,blobs:[blob],entries:[{type:"file",path:"app",mode:0o755,blob:blob.sha256}],runtimes:{supportingFiles:[]},
      provenance:{keyId:"test",signature:"A".repeat(86),sbom:proof,notices:proof,correspondingSources:proof,reproducibility:proof}};
    const first=await buildRootfsPacks(root,manifest,new URL("https://image.test/manifest.json"));
    expect(first.index.blobs).toHaveLength(2);expect(first.artifacts).toHaveLength(1);
    expect(decodeRootfsPackIndex(first.index,[blob,proof])).toEqual(first.index);
    const artifact=first.artifacts[0];if(artifact===undefined)throw new Error("missing pack");
    const compressed=await readFile(join(root,artifact.url.slice(2)));
    expect(hash(compressed)).toBe(artifact.encodedSha256);expect(hash(gunzipSync(compressed))).toBe(artifact.sha256);
    expect(await buildRootfsPacks(root,manifest,new URL("https://image.test/manifest.json"))).toEqual(first);
    await writeFile(join(root,"blobs",hash(file)),Uint8Array.of(9,9,9));
    await expect(buildRootfsPacks(root,manifest,new URL("https://image.test/manifest.json"))).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  } finally {await rm(root,{recursive:true,force:true});}
});

it("packs a recipe's start files first, through symlinks and hardlinks, then every file in path order", async () => {
  const root=await mkdtemp(join(tmpdir(),"oxidevm-pack-order-"));
  try {
    await mkdir(join(root,"blobs")); await mkdir(join(root,"evidence"));
    const bodies={sh:Uint8Array.of(1),big:new Uint8Array(ROOTFS_PACK_BYTES).fill(5),libz:Uint8Array.of(2),late:Uint8Array.of(3)};
    const blob=(bytes:Uint8Array)=>({bytes:bytes.length,sha256:hash(bytes),url:`./blobs/${hash(bytes)}`});
    for(const bytes of Object.values(bodies))await writeFile(join(root,"blobs",hash(bytes)),bytes);
    const evidence=Uint8Array.of(4);await writeFile(join(root,"evidence","proof"),evidence);
    const proof={bytes:evidence.length,sha256:hash(evidence),url:"./evidence/proof"},ownership={uid:0,gid:0};
    const dir=(path:string)=>({type:"directory",path,mode:0o755,ownership}),link=(path:string,target:string)=>({type:"symlink",path,mode:0o777,target,ownership});
    const file=(path:string,bytes:Uint8Array)=>({type:"file",path,mode:0o755,blob:hash(bytes),ownership});
    const entries=[dir("bin"),file("bin/sh",bodies.sh),{type:"hardlink",path:"bin/sh2",mode:0o755,target:"bin/sh",ownership},dir("lib"),file("lib/big",bodies.big),
      link("lib64","lib"),dir("loop"),link("loop/a","b"),link("loop/b","a"),dir("usr"),dir("usr/lib"),link("usr/lib/libz.so.1","libz.so.1.3"),
      file("usr/lib/libz.so.1.3",bodies.libz),dir("zz"),file("zz/late",bodies.late)];
    const blobs=Object.values(bodies).map(blob).sort((a,b)=>a.sha256<b.sha256?-1:1);
    const value={schemaVersion:4,kind:"linux-user-rootfs",id:"test",version:"one",architecture:"x86_64",cpuProfile:"x86-64-v2",sourceDateEpoch:0,
      rootTreeSha256:"a".repeat(64),workspaceBaseSha256:"b".repeat(64),fileCount:entries.length,totalBytes:blobs.reduce((sum,item)=>sum+item.bytes,0),blobs,entries,runtimes:{supportingFiles:[]},
      provenance:{keyId:"test",signature:"A".repeat(86),sbom:proof,notices:proof,correspondingSources:proof,reproducibility:proof}};
    const url=new URL("https://image.test/manifest.json"),manifest=decodeUserspaceRootfsManifest(value,url);
    const order=(first:readonly string[])=>rootfsPackOrder(manifest,{kind:"locality",first}).map(item=>item.sha256);
    const sh=hash(bodies.sh),big=hash(bodies.big),libz=hash(bodies.libz),late=hash(bodies.late);
    expect(order(["usr/lib/libz.so.1","lib64/../zz/late","bin/sh2"])).toEqual([libz,late,sh,big,proof.sha256]);
    expect(order([])).toEqual([sh,big,libz,late,proof.sha256]);
    expect(rootfsPackOrder(manifest,{kind:"digest"}).map(item=>item.sha256)).toEqual([sh,big,libz,late,proof.sha256].sort());
    for(const path of ["usr/lib","missing","loop/a","bin/sh/x"])expect(()=>order([path])).toThrow(expect.objectContaining({code:"INVALID_ARGUMENT"}));
    // The listed files open the first pack; the large file fills it and spills into the second, after the start files.
    const packs=await buildRootfsPacks(root,value,url,undefined,{kind:"locality",first:["usr/lib/libz.so.1","zz/late"]});
    const packed=packs.index.blobs.map(item=>item.sha256),expected=[libz,late,sh,big,proof.sha256];
    expect(expected).not.toEqual([...expected].sort());
    expect(packed).toEqual(expected);
    const chunkOf=(digest:string)=>packs.index.blobs.find(item=>item.sha256===digest)?.extents.map(extent=>packs.index.chunks.findIndex(chunk=>chunk.sha256===extent.chunk));
    expect([chunkOf(libz),chunkOf(late),chunkOf(sh),chunkOf(big)]).toEqual([[0],[0],[0],[0,1]]);
    expect(decodeRootfsPackIndex(packs.index,rootfsClosure(manifest))).toEqual(packs.index);
  } finally {await rm(root,{recursive:true,force:true});}
});

it("authors a manifest-bound sidecar without replacing the signed image or local lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-transport-"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root", "value"), "immutable");
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ id: "legacy", version: "one", mode: "userspace", sourceDateEpoch: 123,
      source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } },
    { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const before = await readFile(built.manifestPath), lock = await readFile(built.lockPath);
    const packed = await packImage(built.bundleDir, { trust: key.trust });
    expect(packed.manifestSHA256).toBe(built.image.manifestSHA256);
    expect(packed.packCount).toBeGreaterThan(0);
    expect(packed.decodedBytes).toBeGreaterThan(0);
    expect(await readFile(built.manifestPath)).toEqual(before);
    expect(await readFile(built.lockPath)).toEqual(lock);
    expect(JSON.parse(await readFile(packed.transportPath, "utf8"))).toMatchObject({ version: 1, manifestSHA256: built.image.manifestSHA256 });
    expect(await packImage(built.bundleDir, { trust: key.trust })).toEqual(packed);
    await expect(packImage(built.bundleDir, { trust: key.trust, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
    const outside = join(root, "outside"); await mkdir(outside);
    await rm(join(built.bundleDir, "packs"), { recursive: true }); await symlink(outside, join(built.bundleDir, "packs"), "dir");
    await expect(packImage(built.bundleDir, { trust: key.trust })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
