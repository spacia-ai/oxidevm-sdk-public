import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { buildRootfsPacks, packImage } from "./rootfs-packs.js";
import { generateImageKey } from "./keys.js";
import { buildImage } from "./build.js";
import { hash } from "./files.js";
import { decodeRootfsPackIndex } from "../runtime/userspace-rootfs-packs.js";

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
