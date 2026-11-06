import { afterEach, expect, it, vi } from "vitest";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, userspaceTreeIdentity } from "../userspace-rootfs.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { ROOTFS_CHECKPOINT_URL } from "./rootfs-checkpoint.test-support.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { RootfsStore } from "./rootfs-store.js";
import { sha256Hex } from "./snapshot-content.js";

const EVIDENCE = ["sbom", "notices", "correspondingSources", "reproducibility"] as const;
const ports: MessagePort[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const port of ports.splice(0)) port.close(); });

function store(): RootfsStore {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  return RootfsStore.opfs(new MemoryDirectory(), new RootfsNetworkClient(channel.port1));
}

/** A signed image with four different evidence files, served by a fetch double that records every request it gets. */
async function evidenceImage(answer: (url: string, body: Uint8Array<ArrayBuffer>) => Response | Promise<Response> = (_url, body) => new Response(body)) {
  const content = new Uint8Array([1, 2, 3]), blob = await sha256Hex(content), files = new Map<string, Uint8Array<ArrayBuffer>>();
  const provenance: Record<string, unknown> = { keyId: "test", signature: "A".repeat(86) };
  for (const name of EVIDENCE) {
    const bytes = new TextEncoder().encode(`${name} of the image`);
    files.set(new URL(`./evidence/${name}`, ROOTFS_CHECKPOINT_URL).href, bytes);
    provenance[name] = { url: `./evidence/${name}`, bytes: bytes.length, sha256: await sha256Hex(bytes) };
  }
  const times = { accessNs: "0", modificationNs: "0" }, ownership = { uid: 1000, gid: 1000 };
  const input = {
    schemaVersion: 6, kind: "linux-user-rootfs", id: "test-rootfs", version: "evidence", architecture: "x86_64", cpuProfile: "x86-64-v2",
    sourceDateEpoch: 1_786_060_800, rootTreeSha256: "0".repeat(64), workspaceBaseSha256: "0".repeat(64), fileCount: 2, totalBytes: content.length,
    blobs: [{ sha256: blob, bytes: content.length, url: "./unread" }],
    entries: [{ type: "directory", path: "bin", mode: 0o755, ownership, times }, { type: "file", path: "bin/app", mode: 0o755, blob, ownership, times }],
    runtimes: { supportingFiles: [] }, provenance,
  };
  const url = new URL(ROOTFS_CHECKPOINT_URL), draft = decodeUserspaceRootfsManifest(input, url);
  Object.assign(input, await userspaceTreeIdentity(draft.entries, draft.blobs, draft.schemaVersion));
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(input, url)));
  provenance["signature"] = Buffer.from(signature).toString("base64url");
  const manifest = new TextEncoder().encode(JSON.stringify(input)), requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn((target: string) => {
    requests.push(target);
    const body = target === ROOTFS_CHECKPOINT_URL ? manifest : files.get(target);
    return Promise.resolve(body === undefined ? new Response(null, { status: 404 }) : target === ROOTFS_CHECKPOINT_URL ? new Response(body) : answer(target, body));
  }));
  return { manifest, digest: await sha256Hex(manifest), requests, evidence: [...files.keys()],
    trusted: { keyId: "test", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)) } };
}

it("prepares the pinned manifest the runtime page verified without fetching it again", async () => {
  const image = await evidenceImage();
  const prepared = await store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice());
  expect(prepared).toMatchObject({ id: "test-rootfs", version: "evidence", identity: { manifestSHA256: image.digest, signatureVerified: true } });
  expect(image.requests).not.toContain(ROOTFS_CHECKPOINT_URL);
  expect([...image.requests].sort()).toEqual([...image.evidence].sort());
});

it("checks handed manifest bytes against their pin and the trusted key as it checks fetched ones", async () => {
  const image = await evidenceImage(), other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const untrusted = { keyId: "test", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)) };
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, "f".repeat(64), false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR", message: "Userspace manifest digest differs from its pin" });
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, untrusted, image.digest, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  // Without a pin, or on a start that may only read the cache, nothing ties handed bytes to the requested image.
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, undefined, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, true, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(image.requests).toEqual([]);
});

it("retains the four evidence files concurrently before it activates the image", async () => {
  const held: (() => void)[] = [];
  let holding = true;
  const image = await evidenceImage((_url, body) => holding ? new Promise(resolve => { held.push(() => { resolve(new Response(body)); }); }) : new Response(body));
  const rootfs = store();
  const outcome = rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice())
    .then(prepared => ({ prepared }), (error: unknown) => ({ error }));
  try {
    await vi.waitFor(() => { expect(held).toHaveLength(EVIDENCE.length); });
    expect(() => rootfs.currentRootfs()).toThrow("No verified rootfs is active");
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
  }
  expect(await outcome).toMatchObject({ prepared: { id: "test-rootfs", version: "evidence" } });
  expect(rootfs.currentRootfs()).toMatchObject({ version: "evidence" });
});

it("reports the first evidence failure in manifest order and activates nothing", async () => {
  const image = await evidenceImage((url, body) => url.endsWith("/notices") ? new Response(null, { status: 404 })
    : url.endsWith("/correspondingSources") ? new Response(new Uint8Array(body.length)) : new Response(body));
  const rootfs = store();
  await expect(rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "STORAGE_ERROR", message: "rootfs fetch returned 404" });
  expect(() => rootfs.currentRootfs()).toThrow("No verified rootfs is active");
});
