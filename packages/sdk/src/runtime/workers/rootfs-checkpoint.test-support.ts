import { packRootfsContents } from "../userspace-rootfs-packing.js";
import type { RootfsPackIndex } from "../userspace-rootfs-packs.js";
import { vi } from "vitest";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, userspaceTreeIdentity } from "../userspace-rootfs.js";
import { sha256Hex } from "./snapshot-content.js";
export const ROOTFS_CHECKPOINT_URL = "https://profiles.example/rootfs/manifest.json";
export async function signedCheckpointRootfsFixture(version = "2026.10.13",schemaVersion:2|3|6|8=2,content = new Uint8Array([1, 2, 3]),fileRoot="bin", signingKeys?:CryptoKeyPair) {
  const evidence = new Uint8Array([4]);
  const blobHash = await sha256Hex(content), evidenceHash = await sha256Hex(evidence);
  const evidenceRef = { url: "./evidence", bytes: 1, sha256: evidenceHash };
  const encoded=new Map<string,Uint8Array<ArrayBuffer>>();
  let packs:{index:RootfsPackIndex;artifacts:{sha256:string;encoding:"gzip";url:string;encodedBytes:number;encodedSha256:string}[]}|undefined;
  if(schemaVersion===8) {
    const artifacts:{sha256:string;encoding:"gzip";url:string;encodedBytes:number;encodedSha256:string}[]=[];
    const index=await packRootfsContents([{sha256:blobHash,bytes:content.length},{sha256:evidenceHash,bytes:1}],async function*(blob){yield await Promise.resolve(blob.sha256===blobHash?content:evidence);},async(chunk,bytes)=>{
      const data=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      const url=`./packs/${chunk.sha256}`;encoded.set(new globalThis.URL(url,ROOTFS_CHECKPOINT_URL).href,data);
      artifacts.push({sha256:chunk.sha256,encoding:"gzip",url,encodedBytes:data.length,encodedSha256:await sha256Hex(data)});
    });packs={index,artifacts};
  }
  const input = {
    schemaVersion, ...(packs===undefined?{}:{packs}), ...(schemaVersion>=3?{workspaceBaseSha256:"0".repeat(64)}:{}),kind: "linux-user-rootfs", id: "test-rootfs", version,
    architecture: "x86_64", cpuProfile: "x86-64-v2", sourceDateEpoch: 1_786_060_800,
    rootTreeSha256: "0".repeat(64), fileCount: 2, totalBytes: content.length,
    blobs: [{ sha256: blobHash, bytes: content.length, url: "./unread" }],
    entries: [{ type: "directory", path: fileRoot, mode: 0o755 }, { type: "file", path: `${fileRoot}/app`, mode: 0o755, blob: blobHash }].map(entry=>({...entry,...(schemaVersion>=4?{ownership:{uid:1000,gid:1000}}:{}),...(schemaVersion>=6?{times:{accessNs:"0",modificationNs:"0"}}:{})})),
    runtimes: { supportingFiles: [] },
    provenance: { keyId: "test", signature: "A".repeat(86), sbom: evidenceRef, notices: evidenceRef, correspondingSources: evidenceRef, reproducibility: evidenceRef },
  };
  const decoded = decodeUserspaceRootfsManifest(input, new globalThis.URL(ROOTFS_CHECKPOINT_URL));
  const identities=await userspaceTreeIdentity(decoded.entries,decoded.blobs,decoded.schemaVersion);
  input.rootTreeSha256=identities.rootTreeSha256;
  if(input.workspaceBaseSha256!==undefined)input.workspaceBaseSha256=identities.workspaceBaseSha256;
  const keys = signingKeys ?? await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(input, new globalThis.URL(ROOTFS_CHECKPOINT_URL)))));
  input.provenance.signature = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const trusted = { keyId: "test", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)) };
  const fetcher = vi.fn((url: string) => Promise.resolve(url.includes("/transport/") && !encoded.has(url)
    ? new Response(null, { status: 404 })
    : new Response(url === ROOTFS_CHECKPOINT_URL ? bytes : encoded.get(url) ?? (url.endsWith("/unread") ? content : evidence))));
  vi.stubGlobal("fetch", fetcher);
  return { bytes, trusted, blobHash, fetcher, keys };
}

