import { describe, expect, it } from "vitest";

import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../userspace-rootfs.js";
import type { SnapshotEntry } from "./workspace-delta.js";
import { rebaseWorkspaceDelta, type WorkspaceImage } from "./workspace-rebase.js";

const owner = { uid: 1000, gid: 1000 };
const encoder = new TextEncoder();

async function digest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** An image whose files hold the given texts; `null` makes a directory. */
async function image(files: Readonly<Record<string, string | null>>): Promise<WorkspaceImage> {
  const entries: UserspaceRootfsEntry[] = [{ type: "directory", path: "workspace", mode: 0o755, ownership: owner }];
  const blobs = new Map<string, UserspaceRootfsBlob>();
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { entries.push({ type: "directory", path: `workspace/${path}`, mode: 0o755, ownership: owner }); continue; }
    const sha256 = await digest(text);
    blobs.set(sha256, { sha256, bytes: encoder.encode(text).byteLength, url: new URL(`https://image.example/${sha256}`) });
    entries.push({ type: "file", path: `workspace/${path}`, mode: 0o644, ownership: owner, blob: sha256 });
  }
  return { entries, blobs: [...blobs.values()] };
}

function resident(path: string, text: string, mode = 0o644, times?: SnapshotEntry["times"]): SnapshotEntry {
  return { tag: 1, mode, ownership: owner, ...(times === undefined ? {} : { times }), path: `/workspace/${path}`, pathBytes: encoder.encode(`/workspace/${path}`), payload: encoder.encode(text) };
}

function directory(path: string): SnapshotEntry {
  return { tag: 0, mode: 0o755, ownership: owner, path: `/workspace/${path}`, pathBytes: encoder.encode(`/workspace/${path}`), payload: new Uint8Array() };
}

function whiteout(path: string): SnapshotEntry {
  return { tag: 5, mode: 0, path: `/workspace/${path}`, pathBytes: encoder.encode(`/workspace/${path}`), payload: new Uint8Array() };
}

async function hostFile(path: string, text: string): Promise<SnapshotEntry> {
  const payload = new Uint8Array(40);
  new DataView(payload.buffer).setBigUint64(0, BigInt(encoder.encode(text).byteLength), true);
  payload.set((await digest(text)).match(/../gu)?.map(pair => Number.parseInt(pair, 16)) ?? [], 8);
  return { tag: 3, mode: 0o644, ownership: owner, path: `/workspace/${path}`, pathBytes: encoder.encode(`/workspace/${path}`), payload };
}

const none = () => Promise.resolve(undefined);
const summary = (delta: readonly SnapshotEntry[]) => delta.map(entry => `${String(entry.tag)} ${entry.path}`);

describe("rebaseWorkspaceDelta", () => {
  it("preserves a device-zero whiteout as an inode through image rebasing", async () => {
    const previous = await image({ "old": "base" });
    const next = await image({ "old": "updated" });
    const inode: SnapshotEntry = { ...whiteout("old"), tag: 7, ownership: owner };
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [inode] });
    expect(result.delta).toEqual([inode]);
    expect(result.conflicts).toEqual([{ reason: "changed-in-both", path: "/workspace/old" }]);
  });

  it("carries the user's changes onto the new image and leaves untouched paths to it", async () => {
    const previous = await image({ "app.ts": "v1", "untouched.ts": "old", "edited.ts": "base" });
    const next = await image({ "app.ts": "v1", "untouched.ts": "new", "edited.ts": "base", "added-by-image.ts": "x" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [resident("edited.ts", "mine"), resident("mine.ts", "hello")] });
    expect(summary(result.delta)).toEqual(["1 /workspace/edited.ts", "1 /workspace/mine.ts"]);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps the user's version of a path the new image changed too, and reports it", async () => {
    const previous = await image({ "page.tsx": "base" });
    const next = await image({ "page.tsx": "updated" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [resident("page.tsx", "mine")] });
    expect(summary(result.delta)).toEqual(["1 /workspace/page.tsx"]);
    expect(result.conflicts).toEqual([{ reason: "changed-in-both", path: "/workspace/page.tsx" }]);
  });

  it("drops an access-time-only record so the new image's file shows through", async () => {
    const previous = await image({ "lib.js": "base" });
    const next = await image({ "lib.js": "updated" });
    const touched = resident("lib.js", "base", 0o644, { accessNs: "5", modificationNs: "7" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [touched] });
    expect(result.delta).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("applies a deletion, reporting it only when the new image changed what was deleted", async () => {
    const previous = await image({ old: null, "old/a": "1", gone: null, "gone/b": "2" });
    const next = await image({ old: null, "old/a": "1", gone: null, "gone/b": "2", "gone/new": "3" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [whiteout("old"), whiteout("gone")] });
    expect(summary(result.delta)).toEqual(["5 /workspace/gone", "5 /workspace/old"]);
    expect(result.conflicts).toEqual([{ reason: "changed-in-both", path: "/workspace/gone" }]);
  });

  it("keeps a host reference the new image serves at that path and inlines one it does not", async () => {
    const previous = await image({ "same.bin": "same", "moved.bin": "earlier" });
    const next = await image({ "same.bin": "same" });
    const content = async (sha256: string) => sha256 === await digest("earlier") ? encoder.encode("earlier") : undefined;
    const kept = { ...await hostFile("same.bin", "same"), mode: 0o755 };
    const copied = await hostFile("copy.bin", "earlier");
    const result = await rebaseWorkspaceDelta({ previous, next, content, delta: [kept, copied] });
    expect(summary(result.delta)).toEqual(["1 /workspace/copy.bin", "3 /workspace/same.bin"]);
    expect(new TextDecoder().decode(result.delta[0]?.payload)).toBe("earlier");
  });

  it("reports a reference to content no longer available and leaves the image's version", async () => {
    const previous = await image({ "data.bin": "earlier" });
    const next = await image({ "data.bin": "later" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [{ ...await hostFile("data.bin", "earlier"), mode: 0o600 }] });
    expect(result.delta).toEqual([]);
    expect(result.conflicts).toEqual([{ reason: "content-unavailable", path: "/workspace/data.bin" }]);
  });

  it("restores a directory the new image dropped when the user kept files in it", async () => {
    const previous = await image({ src: null, "src/a.ts": "a" });
    const next = await image({});
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [resident("src/mine.ts", "mine")] });
    expect(summary(result.delta)).toEqual(["0 /workspace/src", "1 /workspace/src/mine.ts"]);
    expect(result.conflicts).toEqual([{ reason: "changed-in-both", path: "/workspace/src" }]);
  });

  it("replaces a directory the new image added where the user has a file", async () => {
    const previous = await image({});
    const next = await image({ config: null, "config/a": "1" });
    const result = await rebaseWorkspaceDelta({ previous, next, content: none, delta: [resident("config", "file")] });
    expect(summary(result.delta)).toEqual(["5 /workspace/config", "1 /workspace/config"]);
    expect(result.conflicts).toEqual([{ reason: "changed-in-both", path: "/workspace/config" }]);
  });

  it("keeps the user's directories without conflict and reports differences when the earlier image is unknown", async () => {
    const next = await image({ "a.ts": "image", "b.ts": "same" });
    const result = await rebaseWorkspaceDelta({ previous: undefined, next, content: none, delta: [directory("dir"), resident("a.ts", "mine"), resident("b.ts", "same")] });
    expect(summary(result.delta)).toEqual(["1 /workspace/a.ts", "0 /workspace/dir"]);
    expect(result.conflicts).toEqual([{ reason: "base-unknown", path: "/workspace/a.ts" }]);
  });
});
