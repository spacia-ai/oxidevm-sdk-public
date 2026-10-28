import { describe, expect, it } from "vitest";

import { decodeUserspaceRootfsManifest, encodeUserspaceRootfsMetadata, userspaceTreeIdentity, type UserspaceRootfsEntry } from "../userspace-rootfs.js";
import { openUserspaceWorkspace, type UserspaceWorkspaceImages } from "./userspace-workspace-open.js";
import { buildWorkspaceDelta, decodeDelta, encodeDelta, type SnapshotEntry } from "./workspace-delta.js";
import type { WorkspaceImage } from "./workspace-rebase.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";

const owner = { uid: 1000, gid: 1000 };
const encoder = new TextEncoder();

class MemoryBackend implements WorkspaceStoreBackend {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  async *list(prefix: string): AsyncGenerator<string> {
    for (const path of [...this.files.keys()]) if (path.startsWith(prefix)) yield await Promise.resolve(path);
  }
  read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> { return Promise.resolve(this.files.get(path)?.slice()); }
  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> { this.files.set(path, bytes.slice()); return Promise.resolve(); }
  remove(path: string): Promise<void> { this.files.delete(path); return Promise.resolve(); }
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A signed-shape manifest whose /workspace holds `files` (text, or `null` for a directory). */
async function image(files: Readonly<Record<string, string | null>>) {
  const entries: UserspaceRootfsEntry[] = [{ type: "directory", path: "workspace", mode: 0o755, ownership: owner }];
  const blobs = new Map<string, { sha256: string; bytes: number; url: string }>();
  for (const [path, text] of Object.entries(files).sort(([left], [right]) => left < right ? -1 : 1)) {
    if (text === null) { entries.push({ type: "directory", path: `workspace/${path}`, mode: 0o755, ownership: owner }); continue; }
    const sha256 = await digest(encoder.encode(text));
    blobs.set(sha256, { sha256, bytes: encoder.encode(text).byteLength, url: `./blobs/${sha256}` });
    entries.push({ type: "file", path: `workspace/${path}`, mode: 0o644, ownership: owner, blob: sha256 });
  }
  const sortedBlobs = [...blobs.values()].sort((left, right) => left.sha256 < right.sha256 ? -1 : 1);
  const unsigned = decodeUserspaceRootfsManifest(manifestJson(entries, sortedBlobs, "0".repeat(64)), new URL("https://image.example/manifest.json"));
  const base = (await userspaceTreeIdentity(unsigned.entries, unsigned.blobs, 5)).workspaceBaseSha256;
  const manifest = decodeUserspaceRootfsManifest(manifestJson(entries, sortedBlobs, base), new URL("https://image.example/manifest.json"));
  return { base, metadata: encodeUserspaceRootfsMetadata(manifest), tree: { entries: manifest.entries, blobs: manifest.blobs } satisfies WorkspaceImage };
}

function manifestJson(entries: readonly UserspaceRootfsEntry[], blobs: readonly { sha256: string; bytes: number; url: string }[], workspaceBaseSha256: string) {
  const evidence = { url: "./evidence", bytes: 1, sha256: "e".repeat(64) };
  return {
    schemaVersion: 5, kind: "linux-user-rootfs", id: "test-image", version: "1", architecture: "x86_64", cpuProfile: "x86-64-v2",
    sourceDateEpoch: 0, rootTreeSha256: "f".repeat(64), workspaceBaseSha256, fileCount: entries.length,
    totalBytes: blobs.reduce((total, blob) => total + blob.bytes, 0), blobs, entries, runtimes: { supportingFiles: [] },
    provenance: { keyId: "test", signature: "A".repeat(86), sbom: evidence, notices: evidence, correspondingSources: evidence, reproducibility: evidence },
  };
}

function file(path: string, text: string): SnapshotEntry {
  return { tag: 1, mode: 0o644, ownership: owner, path: `/workspace/${path}`, pathBytes: encoder.encode(`/workspace/${path}`), payload: encoder.encode(text) };
}

/** An OXRF snapshot of `entries`: the OXWD layout with the snapshot magic and version. */
function snapshot(entries: readonly SnapshotEntry[]): Uint8Array<ArrayBuffer> {
  const bytes = encodeDelta(entries);
  bytes.set(encoder.encode("OXRF"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, ({ 1: 5, 2: 6, 3: 8 } as Record<number, number>)[view.getUint16(4, true)] ?? 0, true);
  return bytes;
}

function images(known: readonly { readonly base: string; readonly tree: WorkspaceImage }[]): UserspaceWorkspaceImages {
  return {
    workspaceImage: base => Promise.resolve(known.find(item => item.base === base)?.tree),
    cachedBlob: () => Promise.resolve(undefined),
  };
}

const signal = new AbortController().signal;
const paths = (delta: Uint8Array<ArrayBuffer> | undefined) => delta === undefined ? [] : decodeDelta(delta).map(entry => `${String(entry.tag)} ${entry.path}`);

describe("openUserspaceWorkspace", () => {
  it("reports in-sync for no save and for a valid save on the booting image", async () => {
    const booting = await image({ "a.ts": "a" });
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    expect(await openUserspaceWorkspace(store, images([booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal))
      .toEqual({ state: "in-sync", conflicts: [], omittedConflicts: 0 });
    const tree = snapshot([file("a.ts", "a"), file("b.ts", "b")]);
    await store.commit(booting.base, tree, await buildWorkspaceDelta(tree, booting.tree.entries, booting.tree.blobs));
    const before = backend.files.get("active.json");
    expect((await openUserspaceWorkspace(store, images([booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal)).state).toBe("in-sync");
    expect(backend.files.get("active.json")).toEqual(before);
  });

  it("carries a workspace saved on an earlier image onto the booting one instead of failing (regression)", async () => {
    const earlier = await image({ "page.tsx": "base", "lib.ts": "old" });
    const booting = await image({ "page.tsx": "base", "lib.ts": "new", "added.ts": "image" });
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    // The format every earlier SDK wrote: the whole tree plus the delta against its own image.
    const tree = snapshot([file("page.tsx", "mine"), file("lib.ts", "old"), file("notes.md", "user")]);
    await store.commit(earlier.base, tree, await buildWorkspaceDelta(tree, earlier.tree.entries, earlier.tree.blobs));
    await expect(store.readDelta(booting.base)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "workspace-base-mismatch" } });

    const start = await openUserspaceWorkspace(store, images([earlier, booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal);
    expect(start).toEqual({ state: "reconciled", conflicts: [], omittedConflicts: 0 });
    expect(await store.read(booting.base)).toBeUndefined();
    // Only the user's own changes travel; the image's updated lib.ts and added.ts show through.
    expect(paths(await store.readDelta(booting.base))).toEqual(["1 /workspace/notes.md", "1 /workspace/page.tsx"]);
  });

  it("reports a path both sides changed, keeping the user's version", async () => {
    const earlier = await image({ "page.tsx": "base" });
    const booting = await image({ "page.tsx": "updated" });
    const store = new WorkspaceStore(new MemoryBackend());
    const tree = snapshot([file("page.tsx", "mine")]);
    await store.commit(earlier.base, tree, await buildWorkspaceDelta(tree, earlier.tree.entries, earlier.tree.blobs));
    const start = await openUserspaceWorkspace(store, images([earlier, booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal);
    expect(start).toEqual({ state: "conflict-preserved", conflicts: [{ reason: "changed-in-both", path: "/workspace/page.tsx" }], omittedConflicts: 0 });
    expect(paths(await store.readDelta(booting.base))).toEqual(["1 /workspace/page.tsx"]);
  });

  it("rebuilds the changes of a whole-tree save from its earlier image, and sets it aside when that image is unknown", async () => {
    const earlier = await image({ "a.ts": "a" });
    const booting = await image({ "a.ts": "a2" });
    const tree = snapshot([file("a.ts", "a"), file("mine.ts", "m")]);
    const known = new WorkspaceStore(new MemoryBackend());
    await known.commit(earlier.base, tree);
    expect((await openUserspaceWorkspace(known, images([earlier, booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal)).state).toBe("reconciled");
    expect(paths(await known.readDelta(booting.base))).toEqual(["1 /workspace/mine.ts"]);

    const backend = new MemoryBackend();
    const unknown = new WorkspaceStore(backend);
    await unknown.commit(earlier.base, tree);
    const saved = backend.files.get("active.json");
    expect(await openUserspaceWorkspace(unknown, images([booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal))
      .toEqual({ state: "conflict-preserved", conflicts: [], omittedConflicts: 0, preserved: { id: "1", reason: "base-unavailable" } });
    expect(backend.files.get("preserved/1/active.json")).toEqual(saved);
    expect(paths(await unknown.readDelta(booting.base))).toEqual([]);
  });

  it.each([
    ["a corrupt blob", (backend: MemoryBackend) => {
      for (const [path, bytes] of backend.files) if (path.startsWith("blobs/")) backend.files.set(path, bytes.map(byte => byte ^ 1));
      return Promise.resolve();
    }],
    ["an undecodable manifest", (backend: MemoryBackend) => { backend.files.set("active.json", encoder.encode("{not json")); return Promise.resolve(); }],
    ["a malformed delta", async (backend: MemoryBackend) => {
      const garbage = encoder.encode("OXWDgarbage!");
      const sha256 = await digest(garbage);
      backend.files.set(`blobs/${sha256}`, garbage);
      backend.files.set("active.json", encoder.encode(JSON.stringify({ formatVersion: 1, generation: 4, workspaceBaseSha256: "0".repeat(64), deltaSha256: sha256, deltaBytes: garbage.byteLength })));
    }],
  ])("keeps a save with %s aside and boots the image's /workspace", async (_label, damage) => {
    const booting = await image({ "a.ts": "a" });
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    const tree = snapshot([file("a.ts", "changed")]);
    await store.commit(booting.base, tree, await buildWorkspaceDelta(tree, booting.tree.entries, booting.tree.blobs));
    await damage(backend);
    const damaged = backend.files.get("active.json");
    const fresh = new WorkspaceStore(backend);
    const start = await openUserspaceWorkspace(fresh, images([booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal);
    expect(start).toEqual({ state: "conflict-preserved", conflicts: [], omittedConflicts: 0, preserved: { id: "1", reason: "unreadable" } });
    expect(backend.files.get("preserved/1/active.json")).toEqual(damaged);
    expect(await fresh.read(booting.base)).toBeUndefined();
    expect(paths(await fresh.readDelta(booting.base))).toEqual([]);
    // The store is writable again: the next session saves normally.
    await fresh.commit(booting.base, tree, await buildWorkspaceDelta(tree, booting.tree.entries, booting.tree.blobs));
    expect(paths(await fresh.readDelta(booting.base))).toEqual(["1 /workspace/a.ts"]);
    expect(backend.files.get("preserved/1/active.json")).toEqual(damaged);
  });

  it("keeps a save the booting image cannot replay aside", async () => {
    const booting = await image({ "a.ts": "a" });
    const backend = new MemoryBackend();
    const store = new WorkspaceStore(backend);
    // A hardlink whose target is missing decodes but cannot be replayed.
    const link: SnapshotEntry = { tag: 4, mode: 0o644, ownership: owner, path: "/workspace/link", pathBytes: encoder.encode("/workspace/link"), payload: encoder.encode("/workspace/missing") };
    await store.commitDelta(booting.base, encodeDelta([link]));
    const start = await openUserspaceWorkspace(store, images([booting]), { workspaceBaseSha256: booting.base, metadata: booting.metadata }, signal);
    expect(start.preserved).toEqual({ id: "1", reason: "unreplayable" });
    expect(start.state).toBe("conflict-preserved");
  });
});
