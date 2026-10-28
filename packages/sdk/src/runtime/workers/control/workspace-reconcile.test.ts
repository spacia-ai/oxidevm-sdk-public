import { afterEach, describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { SnapshotStorageClient } from "../snapshot-channel.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import { mergeUserspaceWorkspaceDelta } from "../../userspace-rootfs.js";
import { decodeSnapshot } from "../workspace-delta.js";
import type { SnapshotEntry } from "../workspace-delta.js";
import type { WorkspaceChange, WorkspaceIndexEntry, WorkspacePlan } from "../workspace-index.js";
import { conflictCommand, type ReconcileAgent, reconcileRestoredWorkspace, reconcileWorkspace } from "./workspace-reconcile.js";

const SNAPSHOT_ID = "123e4567-e89b-42d3-a456-426614174001";

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? bytes(value) : value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function file(content: string): Promise<WorkspaceIndexEntry> {
  return { kind: "file", mode: 0o644, identity: await sha256(content) };
}

function entry(tag: number, path: string, payload: Uint8Array<ArrayBuffer> = new Uint8Array()): SnapshotEntry {
  return { tag, mode: tag === 0 ? 0o755 : 0o644, path, pathBytes: bytes(path), payload };
}

function metadata(value: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(58), view = new DataView(result.buffer);
  view.setUint32(36, 1, true);
  view.setUint16(40, 9, true);
  view.setUint32(44, 1, true);
  result.set(bytes("user.note"), 48);
  result.set(bytes(value), 57);
  return result;
}

/**
 * A guest agent whose /workspace holds `files` (paths without the /workspace prefix) and
 * `directories`; reading a directory fails, as the agent's file read does.
 */
function agent(files: Record<string, string>, directories: readonly string[] = []) {
  const applied: (readonly [number, string])[][] = [];
  const deltas: Uint8Array<ArrayBuffer>[] = [];
  const kept: (readonly [string, string])[] = [];
  const fake: ReconcileAgent = {
    readEntry: path => Promise.resolve(directories.includes(path) ? { kind: "directory", mode: 0o755 }
      : path in files ? { kind: "file", mode: 0o644 } : undefined),
    readFile: (path) => directories.includes(path)
      ? Promise.reject(new VMError("INVALID_ARGUMENT", "is a directory"))
      : Promise.resolve(path in files ? bytes(files[path] ?? "") : undefined),
    applyDelta: (delta) => {
      deltas.push(delta);
      applied.push(identities(delta));
      return Promise.resolve();
    },
    keepConflict: (target, content) => {
      kept.push([target, new TextDecoder().decode(content)]);
      return Promise.resolve();
    },
  };
  return { fake, applied, kept, deltas };
}

/** The tag and path of each record of an OXWD delta. */
function identities(delta: Uint8Array<ArrayBuffer>): (readonly [number, string])[] {
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  const version = view.getUint16(4, true);
  const header = version === 4 ? 24 : version === 3 ? 36 : version === 2 ? 20 : 12;
  const records: (readonly [number, string])[] = [];
  let offset = 12;
  for (let index = 0; index < view.getUint32(8, true); index += 1) {
    const pathLength = view.getUint32(offset + 4, true);
    const payloadLength = view.getUint32(offset + 8, true);
    records.push([delta[offset] ?? -1, new TextDecoder().decode(delta.subarray(offset + header, offset + header + pathLength))]);
    offset += header + pathLength + payloadLength + (version === 4 ? view.getUint32(offset + 20, true) : 0);
  }
  return records;
}

describe("workspace reconciliation", () => {
  it("applies timestamp-only edits when the guest already holds the same bytes", async () => {
    const guest = agent({ "/file": "unchanged" });
    const times = { accessNs: "12123456789", modificationNs: "-1" };
    const current = { ...entry(1, "/workspace/file", bytes("unchanged")), times };
    const result = await reconcileWorkspace(guest.fake, SNAPSHOT_ID, [
      { path: "/workspace/file", ancestor: await file("unchanged"), current },
    ]);
    expect(result).toEqual({ workspace: "reconciled", unresolved: [] });
    expect(guest.kept).toEqual([]);
    expect(guest.deltas).toHaveLength(1);
    const delta = guest.deltas[0];
    if (delta === undefined) throw new Error("The metadata edit was not transferred");
    const base = Uint8Array.of(79, 88, 82, 70, 4, 0, 0, 0, 0, 0, 0, 0);
    expect(decodeSnapshot(mergeUserspaceWorkspaceDelta(base, delta))).toEqual([current]);
  });

  it.each(["xattr", "mode", "directory"] as const)("leaves divergent guest %s metadata unresolved even when content matches", async kind => {
    const guest = agent({ "/file": "same" });
    const before = metadata("A"), changed = metadata("B"), stored = metadata("C");
    const guestEntry = { kind: kind === "directory" ? "directory" : "file", mode: kind === "mode" ? 0o600 : 0o644,
      metadata: kind === "mode" ? before : changed } as const;
    const fake = { ...guest.fake, readEntry: () => Promise.resolve(guestEntry) };
    const ancestor: WorkspaceIndexEntry = { ...await file("same"), kind: guestEntry.kind,
      metadataSha256: await sha256(before) };
    const current = { ...entry(kind === "directory" ? 0 : 1, "/workspace/file", kind === "directory" ? new Uint8Array() : bytes("same")),
      mode: kind === "mode" ? 0o640 : 0o644, metadata: kind === "mode" ? before : stored };
    expect(await reconcileWorkspace(fake, SNAPSHOT_ID, [{ path: current.path, ancestor, current }]))
      .toEqual({ workspace: "conflict-preserved", unresolved: [current.path] });
    expect(guest.applied).toEqual([]);
    expect(guest.kept).toEqual([]);
  });

  it.each(["delete", "replace"] as const)("preserves unindexed rich guest metadata when a legacy store asks to %s", async operation => {
    const guest = agent({ "/file": "same" });
    const fake = { ...guest.fake, readEntry: () => Promise.resolve({ kind: "file", mode: 0o644, metadata: metadata("B") } as const) };
    const path = "/workspace/file";
    const current = operation === "delete" ? null : entry(1, path, bytes("same"));
    expect(await reconcileWorkspace(fake, SNAPSHOT_ID, [{ path, ancestor: await file("same"), current }]))
      .toEqual({ workspace: "conflict-preserved", unresolved: [path] });
    expect(guest.applied).toEqual([]);
    expect(guest.kept).toEqual([]);
  });

  it.each(["unchanged", "agreed"] as const)("reconciles rich metadata when the guest is %s", async state => {
    const guest = agent({ "/file": "same" }), before = metadata("A"), current = metadata("B");
    const fake = { ...guest.fake, readEntry: () => Promise.resolve({ kind: "file", mode: 0o644,
      metadata: state === "unchanged" ? before : current } as const) };
    const path = "/workspace/file";
    expect(await reconcileWorkspace(fake, SNAPSHOT_ID, [{ path,
      ancestor: { ...await file("same"), metadataSha256: await sha256(before) },
      current: { ...entry(1, path, bytes("same")), metadata: current } }]))
      .toEqual({ workspace: state === "unchanged" ? "reconciled" : "in-sync", unresolved: [] });
    expect(guest.applied).toEqual(state === "unchanged" ? [[[1, path]]] : []);
    expect(guest.kept).toEqual([]);
  });

  it("applies metadata-only changes even when guest file bytes already match", async () => {
    const guest = agent({ "/file": "same" });
    await reconcileWorkspace(guest.fake, SNAPSHOT_ID, [{ path: "/workspace/file", ancestor: await file("same"),
      current: { ...entry(1, "/workspace/file", bytes("same")), metadata: new Uint8Array(40) } }]);
    expect(guest.applied).toEqual([[[1, "/workspace/file"]]]);
    expect(guest.kept).toEqual([]);
  });

  it("reconciles a FIFO without reading it or waiting for a peer", async () => {
    const guest = agent({});
    const fake: ReconcileAgent = { ...guest.fake, readEntry: () => Promise.resolve({ kind: "fifo", mode: 0o600 }),
      readFile: () => Promise.reject(new Error("FIFO read would block")) };
    await reconcileWorkspace(fake, SNAPSHOT_ID, [{ path: "/workspace/pipe", ancestor: { kind: "fifo", mode: 0o600, identity: "" },
      current: { ...entry(6, "/workspace/pipe"), metadata: new Uint8Array(40) } }]);
    expect(guest.applied).toEqual([[[6, "/workspace/pipe"]]]);
  });

  it("applies the store's changes to paths the guest did not change", async () => {
    const guest = agent({ "/edited.ts": "before", "/removed.ts": "gone" });
    const changes: WorkspaceChange[] = [
      { path: "/workspace/added.ts", ancestor: null, current: entry(1, "/workspace/added.ts", bytes("new")) },
      { path: "/workspace/edited.ts", ancestor: await file("before"), current: entry(1, "/workspace/edited.ts", bytes("after")) },
      { path: "/workspace/removed.ts", ancestor: await file("gone"), current: null },
    ];

    const result = await reconcileWorkspace(guest.fake, SNAPSHOT_ID, changes);

    expect(result).toEqual({ workspace: "reconciled", unresolved: [] });
    expect(guest.applied).toEqual([[[1, "/workspace/added.ts"], [1, "/workspace/edited.ts"], [5, "/workspace/removed.ts"]]]);
    expect(guest.kept).toEqual([]);
  });

  it("keeps the guest's copy outside /workspace where both sides changed a path differently", async () => {
    const guest = agent({ "/src/app.ts": "guest edit", "/same.ts": "agreed" });
    const changes: WorkspaceChange[] = [
      { path: "/workspace/src/app.ts", ancestor: await file("before"), current: entry(1, "/workspace/src/app.ts", bytes("store edit")) },
      { path: "/workspace/same.ts", ancestor: await file("before"), current: entry(1, "/workspace/same.ts", bytes("agreed")) },
    ];

    const result = await reconcileWorkspace(guest.fake, SNAPSHOT_ID, changes);

    expect(result).toEqual({ workspace: "conflict-preserved", unresolved: [] });
    expect(guest.kept).toEqual([[`/var/lib/oxidevm/conflicts/${SNAPSHOT_ID}/src/app.ts`, "guest edit"]]);
    expect(guest.applied).toEqual([[[1, "/workspace/src/app.ts"]]]);
  });

  it("keeps a file the guest changed that the store removed", async () => {
    const guest = agent({ "/notes.md": "guest notes" });

    const result = await reconcileWorkspace(guest.fake, SNAPSHOT_ID, [
      { path: "/workspace/notes.md", ancestor: await file("old notes"), current: null },
    ]);

    expect(result.workspace).toBe("conflict-preserved");
    expect(guest.kept).toEqual([[`/var/lib/oxidevm/conflicts/${SNAPSHOT_ID}/notes.md`, "guest notes"]]);
    expect(guest.applied).toEqual([[[5, "/workspace/notes.md"]]]);
  });

  it("leaves a file the store returned to base content when the guest no longer holds that content", async () => {
    const guest = agent({ "/package.json": "edited" });
    const reference = new Uint8Array(40);

    const result = await reconcileWorkspace(guest.fake, SNAPSHOT_ID, [
      { path: "/workspace/package.json", ancestor: await file("edited"), current: entry(3, "/workspace/package.json", reference) },
    ]);

    // The guest's file stays where it is; the result names the store change it could not take.
    expect(result).toEqual({ workspace: "conflict-preserved", unresolved: ["/workspace/package.json"] });
    expect(guest.kept).toEqual([]);
    expect(guest.applied).toEqual([]);
  });

  it("creates directories but never removes one, so files the guest added there stay", async () => {
    const guest = agent({ "/old/mine.txt": "guest only" }, ["/old"]);

    await reconcileWorkspace(guest.fake, SNAPSHOT_ID, [
      { path: "/workspace/new", ancestor: null, current: entry(0, "/workspace/new") },
      { path: "/workspace/old", ancestor: { kind: "directory", mode: 0o755, identity: "" }, current: null },
    ]);

    expect(guest.applied).toEqual([[[0, "/workspace/new"]]]);
  });
});

describe("resumed workspace", () => {
  const SNAPSHOT = { id: SNAPSHOT_ID, createdAt: "2026-10-02T10:00:00.000Z" };
  const opened: { close(): void }[] = [];

  afterEach(() => {
    for (const resource of opened.splice(0)) resource.close();
  });

  /** Snapshot storage over a real channel that answers `plan-workspace` with `plan`. */
  function storage(plan: WorkspacePlan) {
    const requests: string[] = [];
    const { port1, port2 } = new MessageChannel();
    const server = serveSnapshotStorage(port1, (request) => {
      requests.push(request.type);
      return request.type === "plan-workspace" ? Promise.resolve(plan) : Promise.reject(new Error(`unexpected ${request.type}`));
    });
    const client = new SnapshotStorageClient(port2);
    opened.push({ close: () => { client.close(); void server.close(); } });
    return { client, requests };
  }

  it("carries a Userspace edit made after the save into the resumed guest", async () => {
    const guest = agent({ "/app.ts": "saved" });
    const { client, requests } = storage({
      kind: "changed",
      generation: 4,
      changes: [{ path: "/workspace/app.ts", ancestor: await file("saved"), current: entry(1, "/workspace/app.ts", bytes("edited in Userspace")) }],
    });

    const result = await reconcileRestoredWorkspace(client, guest.fake, SNAPSHOT);

    expect(requests).toEqual(["plan-workspace"]);
    expect(result).toEqual({ workspace: "reconciled", unresolved: [] });
    expect(guest.applied).toEqual([[[1, "/workspace/app.ts"]]]);
  });

  it("leaves the guest alone when the store has not changed since the save", async () => {
    const guest = agent({});

    for (const plan of [{ kind: "in-sync" }, { kind: "unrecorded" }] as const) {
      await expect(reconcileRestoredWorkspace(storage(plan).client, guest.fake, SNAPSHOT)).resolves.toEqual({ workspace: "in-sync", unresolved: [] });
    }
    expect(guest.applied).toEqual([]);
  });

  it("says in sync when a newer store holds nothing the guest lacks, so no Userspace change is claimed", async () => {
    const guest = agent({ "/app.ts": "saved" });
    const plans: WorkspacePlan[] = [
      // Userspace wrote its files back without changing any.
      { kind: "changed", generation: 5, changes: [] },
      // The store gained what the guest already holds.
      { kind: "changed", generation: 6, changes: [{ path: "/workspace/app.ts", ancestor: null, current: entry(1, "/workspace/app.ts", bytes("saved")) }] },
    ];

    for (const plan of plans) {
      await expect(reconcileRestoredWorkspace(storage(plan).client, guest.fake, SNAPSHOT)).resolves.toEqual({ workspace: "in-sync", unresolved: [] });
    }
    expect(guest.applied).toEqual([]);
  });

  it("keeps a conflicting copy with one shell command that takes the bytes on stdin", () => {
    expect(conflictCommand(`/var/lib/oxidevm/conflicts/${SNAPSHOT_ID}/src/a b.ts`)).toEqual([
      "sh",
      "-c",
      'mkdir -p -- "${1%/*}" && exec cat > "$1"',
      "sh",
      `/var/lib/oxidevm/conflicts/${SNAPSHOT_ID}/src/a b.ts`,
    ]);
  });
});
