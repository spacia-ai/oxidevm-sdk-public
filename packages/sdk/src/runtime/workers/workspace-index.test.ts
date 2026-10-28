import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import {
  decodeWorkspaceIndex,
  decodeWorkspacePlan,
  encodeWorkspaceIndex,
  indexWorkspaceSnapshot,
  workspaceChanges,
} from "./workspace-index.js";
import { type WorkspaceSnapshotRecord as Entry, workspaceSnapshot } from "./workspace-snapshot.test-support.js";

const NONE = new Uint8Array();

function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A base reference: the file keeps its base image bytes (u64 size, then their SHA-256). */
async function baseReference(content: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const reference = new Uint8Array(40);
  new DataView(reference.buffer).setBigUint64(0, BigInt(content.byteLength), true);
  reference.set(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), 8);
  return reference;
}

const snapshot = workspaceSnapshot;

const ANCESTOR: readonly Entry[] = [
  [0, 0o755, "/workspace/src", NONE],
  [1, 0o644, "/workspace/src/kept.ts", text("kept")],
  [1, 0o644, "/workspace/src/edited.ts", text("before")],
  [1, 0o644, "/workspace/src/removed.ts", text("gone")],
  [1, 0o644, "/workspace/run.sh", text("echo")],
  [2, 0o777, "/workspace/latest", text("src/kept.ts")],
];

describe("workspace index", () => {
  it("records each path's kind, mode and content identity and round-trips", async () => {
    const index = await indexWorkspaceSnapshot(snapshot(ANCESTOR));

    expect(index.get("/workspace/src/edited.ts")).toEqual({ kind: "file", mode: 0o644, identity: await sha256(text("before")) });
    expect(index.get("/workspace/latest")).toEqual({ kind: "symlink", mode: 0o777, identity: "src/kept.ts" });
    expect(index.get("/workspace/src")).toEqual({ kind: "directory", mode: 0o755, identity: "" });
    expect(decodeWorkspaceIndex(encodeWorkspaceIndex(index))).toEqual(index);
  });

  it("finds the paths the store changed since the indexed generation", async () => {
    const index = await indexWorkspaceSnapshot(snapshot(ANCESTOR));
    const current = snapshot([
          [0, 0o755, "/workspace/src", NONE],
      [1, 0o644, "/workspace/src/kept.ts", text("kept")],
      [1, 0o644, "/workspace/src/edited.ts", text("after")],
      [1, 0o644, "/workspace/src/added.ts", text("new")],
      [1, 0o755, "/workspace/run.sh", text("echo")],
      [2, 0o777, "/workspace/latest", text("src/kept.ts")],
    ]);

    const changes = await workspaceChanges(index, current);

    expect(changes.map(({ path, ancestor, current }) => [path, ancestor?.kind ?? null, current?.tag ?? null])).toEqual([
      ["/workspace/run.sh", "file", 1],
      ["/workspace/src/added.ts", null, 1],
      ["/workspace/src/edited.ts", "file", 1],
      ["/workspace/src/removed.ts", "file", null],
    ]);
    expect(new TextDecoder().decode(changes[2]?.current?.payload)).toBe("after");
  });

  it("leaves the /workspace root to each runtime, so a store snapshot that records it otherwise changes nothing", async () => {
    // System's capture records the root; Userspace's runtime owns its own and leaves it out.
    const index = await indexWorkspaceSnapshot(snapshot([[0, 0o755, "/workspace", NONE], ...ANCESTOR], 6));

    for (const root of [[], [[0, 0o777, "/workspace", NONE]]] satisfies readonly (readonly Entry[])[]) {
      const changes = await workspaceChanges(index, snapshot([...root, ...ANCESTOR], 6));

      expect(changes).toEqual([]);
      expect(decodeWorkspacePlan({ kind: "changed", generation: 2, changes })).toEqual({ kind: "changed", generation: 2, changes: [] });
    }
  });

  it("treats inline bytes and a base reference to the same bytes as the same content", async () => {
    const index = await indexWorkspaceSnapshot(snapshot([[1, 0o644, "/workspace/package.json", text("{}")]]));

    const changes = await workspaceChanges(index, snapshot([[3, 0o644, "/workspace/package.json", await baseReference(text("{}"))]]));

    expect(changes).toEqual([]);
  });

  it("rejects an index that is not exactly a workspace index", async () => {
    const encoded = encodeWorkspaceIndex(await indexWorkspaceSnapshot(snapshot(ANCESTOR)));
    const document: unknown = JSON.parse(new TextDecoder().decode(encoded));

    for (const variant of [
      { ...Object(document), formatVersion: 5 },
      { ...Object(document), extra: true },
      { formatVersion: 1, entries: [["relative", "file", 420, ""]] },
      { formatVersion: 1, entries: [["/workspace/a", "socket", 420, ""]] },
      { formatVersion: 1, entries: [["/workspace/a", "file", 420, "nothex"]] },
      { formatVersion: 1, entries: [["/workspace/a", "directory", 493, ""], ["/workspace/a", "directory", 493, ""]] },
    ]) {
      expect(() => decodeWorkspaceIndex(text(JSON.stringify(variant)))).toThrow(VMError);
    }
  });

  it("decodes a workspace plan received from the storage worker strictly", async () => {
    const changes = await workspaceChanges(await indexWorkspaceSnapshot(snapshot(ANCESTOR)), snapshot([
      [0, 0o755, "/workspace/src", NONE],
      [1, 0o644, "/workspace/src/edited.ts", text("after")],
    ]));
    const plan = { kind: "changed", generation: 5, changes };

    expect(decodeWorkspacePlan(structuredClone(plan))).toEqual(plan);
    expect(decodeWorkspacePlan({ kind: "in-sync" })).toEqual({ kind: "in-sync" });
    const [first] = changes;
    for (const malformed of [
      { kind: "in-sync", extra: true },
      { kind: "changed", generation: 0, changes },
      { kind: "changed", generation: 5, changes: [{ ...first, path: "/etc/passwd" }] },
      { kind: "changed", generation: 5, changes: [{ ...first, current: { ...first?.current, tag: 9 } }] },
      { kind: "changed", generation: 5, changes: [{ ...first, ancestor: { kind: "socket", mode: 0, identity: "" } }] },
      { kind: "later" },
    ]) {
      expect(() => decodeWorkspacePlan(malformed)).toThrow(VMError);
    }
  });
});
