import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BootProgress } from "./contracts.js";
import type * as EngineAssets from "./engine-assets.js";
import type { LoadedEngineAssets } from "./engine-assets.js";
import { createVM, defineImage } from "./index.js";
import { VMError } from "./runtime/errors.js";
import { ScriptedWorker } from "./runtime/system-vm.test-support.js";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, userspaceTreeIdentity } from "./runtime/userspace-rootfs.js";

/** The engine load that a test may hold open, and the storage requests that would prepare the image. */
const state = vi.hoisted(() => ({ engine: Promise.resolve(), prepared: new Array<Record<string, unknown>>() }));
vi.mock("./license-admission.js", () => ({ admitLicense: () => Promise.resolve({ tier: "development" }) }));
vi.mock("./runtime/userspace-process.js", async () => {
  const { nativeBackend } = await import("./runtime/userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});
vi.mock("./engine-assets.js", async importOriginal => ({
  ...await importOriginal<typeof EngineAssets>(),
  loadEngineAssets: async (_mode: unknown, _base: unknown, _signal: unknown, progress?: (update: BootProgress) => void): Promise<LoadedEngineAssets> => {
    progress?.({ phase: "download", asset: "engine", completedBytes: 1, totalBytes: 2 });
    await state.engine;
    progress?.({ phase: "download", asset: "engine", completedBytes: 2, totalBytes: 2 });
    return { urls: new Map([["oxidevm_userspace.wasm", "blob:oxidevm_userspace.wasm"]]), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))),
      lazy: () => Promise.reject(new Error("unused")), dispose: () => undefined };
  },
}));

const MANIFEST_URL = "https://images.example/rootfs/manifest.json";
const STOP = "stopped after the storage owner received the image";

/** A whole-manifest signed Userspace image served by a fetch double; `requests` lists every URL the page fetched. */
async function servedImage() {
  const ownership = { uid: 0, gid: 0 }, blob = "a".repeat(64), evidence = (name: string, digit: string) => ({ url: `./evidence/${name}`, bytes: 1, sha256: digit.repeat(64) });
  const draft = {
    schemaVersion: 5, kind: "linux-user-rootfs", id: "start", version: "1", architecture: "x86_64", cpuProfile: "x86-64-v2", sourceDateEpoch: 1_786_060_800,
    rootTreeSha256: blob, workspaceBaseSha256: blob, fileCount: 2, totalBytes: 4, blobs: [{ sha256: blob, bytes: 4, url: "./blobs/aa" }],
    entries: [{ type: "directory", path: "bin", mode: 0o755, ownership }, { type: "file", path: "bin/sh", mode: 0o755, blob, ownership }],
    runtimes: { supportingFiles: [] },
    provenance: { keyId: "author", signature: "A".repeat(86), sbom: evidence("sbom", "b"), notices: evidence("notices", "c"),
      correspondingSources: evidence("sources", "d"), reproducibility: evidence("reproducibility", "e") },
  };
  const url = new URL(MANIFEST_URL), decoded = decodeUserspaceRootfsManifest(draft, url);
  const unsigned = { ...draft, ...await userspaceTreeIdentity(decoded.entries, decoded.blobs, draft.schemaVersion) };
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(unsigned, url)))).toString("base64url");
  const bytes = new TextEncoder().encode(JSON.stringify({ ...unsigned, provenance: { ...unsigned.provenance, signature } })), requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn((target: string | URL) => {
    requests.push(String(target));
    return Promise.resolve(String(target) === MANIFEST_URL ? new Response(bytes.slice()) : new Response(null, { status: 404 }));
  }));
  const image = defineImage({ mode: "userspace", manifestUrl: MANIFEST_URL, manifestSHA256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
    trust: { algorithm: "Ed25519", keyId: "author", publicKey: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64") } });
  return { image, bytes, requests };
}

beforeEach(() => {
  vi.stubGlobal("Worker", ScriptedWorker);
  vi.stubGlobal("location", new URL("https://app.example.test/"));
  vi.stubGlobal("crossOriginIsolated", false);
  ScriptedWorker.answers.set("prepare-userspace-rootfs", input => { state.prepared.push(input); throw new VMError("STORAGE_ERROR", STOP); });
});
afterEach(() => {
  ScriptedWorker.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.engine = Promise.resolve(); state.prepared.length = 0;
});

it("fetches a cold start's image manifest once and hands the verified bytes to the storage owner", async () => {
  const served = await servedImage();
  await expect(createVM({ mode: "userspace", image: served.image, commandInterceptors: "off" })).rejects.toMatchObject({ message: STOP });
  expect(served.requests).toEqual([MANIFEST_URL]);
  expect(state.prepared).toHaveLength(1);
  expect(state.prepared[0]).toMatchObject({ manifestUrl: MANIFEST_URL, manifestSHA256: served.image.manifestSHA256 });
  expect(state.prepared[0]?.["manifestBytes"]).toEqual(served.bytes);
});

it("fetches and verifies the image manifest while the engine loads", async () => {
  const served = await servedImage(), engine = Promise.withResolvers<undefined>();
  state.engine = engine.promise.then(() => undefined);
  const creating = createVM({ mode: "userspace", image: served.image, commandInterceptors: "off" }).then(() => undefined, (error: unknown) => error);
  try { await vi.waitFor(() => { expect(served.requests).toEqual([MANIFEST_URL]); }); }
  finally { engine.resolve(undefined); }
  expect(await creating).toMatchObject({ message: STOP });
  expect(state.prepared[0]?.["manifestBytes"]).toEqual(served.bytes);
});

it("reports the image's progress after the engine's while both download at once", async () => {
  const served = await servedImage(), engine = Promise.withResolvers<undefined>(), events: BootProgress[] = [];
  const verifying = vi.spyOn(crypto.subtle, "verify");
  state.engine = engine.promise.then(() => undefined);
  const creating = createVM({ mode: "userspace", image: served.image, commandInterceptors: "off", onProgress: update => { events.push(update); } })
    .then(() => undefined, (error: unknown) => error);
  try {
    // The manifest is downloaded, validated and its signature checked before the engine finishes.
    await vi.waitFor(() => { expect(verifying).toHaveBeenCalledOnce(); });
    await verifying.mock.results[0]?.value;
  } finally { engine.resolve(undefined); }
  expect(await creating).toMatchObject({ message: STOP });
  expect(events).toEqual([
    { phase: "download", asset: "engine", completedBytes: 1, totalBytes: 2 },
    { phase: "download", asset: "engine", completedBytes: 2, totalBytes: 2 },
    expect.objectContaining({ phase: "download", asset: "image", completedBytes: served.bytes.length }),
    { phase: "validate" },
  ]);
});
