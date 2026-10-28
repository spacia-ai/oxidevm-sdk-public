import {expect,it,vi} from "vitest";
import {inspectStoredStartImage} from "./startup-image.js";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {canonicalManagedImageBytes,decodeManagedImageManifest,managedImageIdentityBytes} from "../managed-image.js";
import {managedBaseMarker} from "../managed-disk-state.js";
import {managedImageStem,readDiskHead,writeDiskHead,writeGenerationRecord} from "./managed-disk-head.js";
import {pinManagedImage,setWorkspacePins} from "./managed-image-pins.js";
import {writeOpfsFile} from "./snapshot-objects.js";
import {sha256Hex} from "./snapshot-content.js";
import {prepareManagedDisk} from "./managed-image-cache.js";
import {currentSystemImage} from "./current-system-image.js";
import {ManagedBases} from "./managed-base.js";
async function signedRetainedSystemImage() {
  const origin=new MemoryDirectory(),oxidevm=await origin.getDirectoryHandle("oxidevm",{create:true});
  const workspace=await (await oxidevm.getDirectoryHandle("workspaces",{create:true})).getDirectoryHandle("ws",{create:true});
  const images=await oxidevm.getDirectoryHandle("managed-images",{create:true});
  const bytes=[new Uint8Array(4096).fill(1),new Uint8Array(4096).fill(2)];
  const kernel=new Uint8Array([1]);
  const artifact={url:"./a",bytes:1,sha256:await sha256Hex(kernel)};
  const input={schemaVersion:9,id:"kept",version:"old",architecture:"x86_64",sourceDateEpoch:0,memoryMiB:256,vcpus:{minimum:1,maximum:1},cpuProfile:"x86-64-v2",workspaceBaseSha256:"c".repeat(64),commandLine:"console=hvc0",kernel:artifact,
    disk:{bytes:16384,blockBytes:4096,chunkBytes:4096,chunks:await Promise.all(bytes.map(async(data,index)=>({index:index*3,url:`./chunk-${String(index)}`,bytes:data.length,sha256:await sha256Hex(data),encoding:"gzip",encodedBytes:1,encodedSha256:"a".repeat(64)})))},
    runtimes:{kind:"custom",versions:{python:"3.13"}},provenance:{keyId:"test",signature:"A".repeat(86),sbom:artifact,notices:artifact,correspondingSources:artifact,reproducibility:artifact}};
  const url=new URL("https://old.test/manifest.json"),key=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  const signature=new Uint8Array(await crypto.subtle.sign("Ed25519",key.privateKey,canonicalManagedImageBytes(decodeManagedImageManifest(input,url))));
  input.provenance.signature=btoa(String.fromCharCode(...signature)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
  const text=JSON.stringify(input),manifest=decodeManagedImageManifest(input,url),identity=await sha256Hex(managedImageIdentityBytes(input,text,manifest));
  const ref={id:manifest.id,version:manifest.version,identity},stem=managedImageStem(ref),pack=new Uint8Array(8192);pack.set(bytes[0]??new Uint8Array(),0);pack.set(bytes[1]??new Uint8Array(),4096);
  await pinManagedImage(images,"ws",{ref,url,manifestText:text,kernel});
  await writeOpfsFile(images,`${stem}.pack`,pack);await writeOpfsFile(images,`${stem}.complete`,new TextEncoder().encode(managedBaseMarker(pack.length,identity)));
  const disks=await workspace.getDirectoryHandle("managed-disks",{create:true});
  await writeGenerationRecord(await disks.getDirectoryHandle(stem,{create:true}),{schema:1,image:ref,bytes:16384,changeBase:null});
  await writeDiskHead(disks,{schema:1,generation:stem,previous:null,resume:null});
  return {origin,oxidevm,workspace,images,stem,text,url,manifest,trusted:{keyId:"test",publicKey:new Uint8Array(await crypto.subtle.exportKey("raw",key.publicKey))}};
}
it("reads a retained signed system image and sparse packed base entirely offline",async()=>{
  const f=await signedRetainedSystemImage(),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new TypeError("offline"));
  try {
    const result=await inspectStoredStartImage(f.origin,{workspaceId:"ws",mode:"system",resume:"latest",manifestUrl:"https://new.test/manifest.json",manifestSHA256:"b".repeat(64),trustedKeyId:f.trusted.keyId,trustedPublicKey:f.trusted.publicKey},new AbortController().signal);
    expect(result).toMatchObject({image:{id:"kept",version:"old",mode:"system",cpuProfile:"x86-64-v2",manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text)),signatureVerified:true},memoryMiB:256,vcpus:1});
    expect(fetcher).not.toHaveBeenCalled();
    const prepared=await prepareManagedDisk({oxidevm:f.oxidevm,workspace:f.workspace,workspaceId:"ws",bases:new ManagedBases()},f.url.href,f.trusted,"live",()=>{}, {manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text)),cachedOnly:true});
    expect(prepared.image.identity).toEqual(result?.image);
    expect(await currentSystemImage(f.images,prepared.disk.image,f.trusted,{id:"requested",version:"new"})).toEqual({id:"kept",version:"old",identity:result?.image,runtimes:{kind:"custom",versions:{python:"3.13"}},workspaceBaseSha256:"c".repeat(64),update:{id:"requested",version:"new"}});expect(fetcher).not.toHaveBeenCalled();prepared.disk.close();
    await writeOpfsFile(f.images,`${f.stem}.pack`,new Uint8Array(4096));
    await expect(inspectStoredStartImage(f.origin,{workspaceId:"ws",mode:"system",resume:"none",manifestUrl:f.url.href,manifestSHA256:"b".repeat(64),trustedKeyId:f.trusted.keyId,trustedPublicKey:f.trusted.publicKey},new AbortController().signal)).resolves.toBeNull();
  } finally {fetcher.mockRestore();}
});

it("does not scan a retained system base at startup and verifies each used chunk before guest delivery",async()=>{
  const f=await signedRetainedSystemImage();
  const reading=vi.spyOn(Blob.prototype,"arrayBuffer"),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new TypeError("offline"));
  try {
    await inspectStoredStartImage(f.origin,{workspaceId:"ws",mode:"system",resume:"latest",manifestUrl:f.url.href,manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text)),trustedKeyId:f.trusted.keyId,trustedPublicKey:f.trusted.publicKey},new AbortController().signal);
    const storage={oxidevm:f.oxidevm,workspace:f.workspace,workspaceId:"ws",bases:new ManagedBases()};
    const prepared=await prepareManagedDisk(storage,f.url.href,f.trusted,"live",()=>{}, {cachedOnly:true,manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text))});
    try {
      expect(reading.mock.contexts.filter((body:unknown)=>body instanceof Blob&&body.size===4096)).toHaveLength(0);
      const data=new Uint8Array(1);prepared.disk.read(0,data);expect(data).toEqual(Uint8Array.of(1));
    } finally {prepared.disk.close();}
    await writeOpfsFile(f.images,`${f.stem}.pack`,new Uint8Array(8192));
    const damaged=await prepareManagedDisk(storage,f.url.href,f.trusted,"live",()=>{}, {cachedOnly:true,manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text))});
    try {expect(()=>damaged.disk.read(0,new Uint8Array(1))).toThrowError("Cached image chunk is damaged");}
    finally {damaged.disk.close();}
    expect(fetcher).not.toHaveBeenCalled();
  } finally {reading.mockRestore();fetcher.mockRestore();}
});

it("selects the exact installed system image for a new workspace entirely offline",async()=>{
  const f=await signedRetainedSystemImage(),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new TypeError("offline"));
  try {
    expect(await inspectStoredStartImage(f.origin,{workspaceId:"new-workspace",mode:"system",resume:"none",manifestUrl:f.url.href,
      manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text)),trustedKeyId:f.trusted.keyId,trustedPublicKey:f.trusted.publicKey},new AbortController().signal))
      .toMatchObject({image:{id:"kept",version:"old",signatureVerified:true},manifestUrl:f.url.href});
    const workspace=await (await f.oxidevm.getDirectoryHandle("workspaces")).getDirectoryHandle("new-workspace",{create:true});
    const storage={oxidevm:f.oxidevm,workspace,workspaceId:"new-workspace",bases:new ManagedBases()};
    const policy={cachedOnly:true,manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text))};
    const prepared=await prepareManagedDisk(storage,f.url.href,f.trusted,"live",()=>{},policy);
    expect(prepared.image.identity?.manifestSHA256).toBe(policy.manifestSHA256);prepared.disk.close();
    await setWorkspacePins(f.images,"new-workspace",new Set());
    const reopened=await prepareManagedDisk(storage,f.url.href,f.trusted,"live",()=>{},policy);
    expect(reopened.disk.generation).toBe(prepared.disk.generation);reopened.disk.close();
    expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
});

it("does not replace an unavailable live disk image with another globally installed image",async()=>{
  const f=await signedRetainedSystemImage(),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new TypeError("offline"));
  try{
    const ref={id:"unavailable",version:"1",identity:"d".repeat(64)},generation=managedImageStem(ref);
    const disks=await f.workspace.getDirectoryHandle("managed-disks");
    await writeGenerationRecord(await disks.getDirectoryHandle(generation,{create:true}),{schema:1,image:ref,bytes:16384,changeBase:null});
    await writeDiskHead(disks,{schema:1,generation,previous:null,resume:null});await setWorkspacePins(f.images,"ws",new Set());
    await expect(prepareManagedDisk({oxidevm:f.oxidevm,workspace:f.workspace,workspaceId:"ws",bases:new ManagedBases()},f.url.href,f.trusted,"live",()=>{},
      {cachedOnly:true,manifestSHA256:await sha256Hex(new TextEncoder().encode(f.text))})).rejects.toMatchObject({code:"STORAGE_NOT_FOUND"});
    expect((await readDiskHead(disks))?.generation).toBe(generation);expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
});
