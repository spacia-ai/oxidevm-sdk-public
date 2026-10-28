import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { MAX_WORKSPACE_CHANGES, MAX_WORKSPACE_FILE_BYTES } from "../../runtime/workspace-files.js";
import type { WorkspaceChange, WorkspaceFileEntry } from "../../runtime/workspace-files.js";
import { decodeWorkspaceChanges } from "../../runtime/protocol/workspace-files.js";
import { FRAME_PROTOCOL_VERSION } from "./handshake.js";
import { MAX_FRAME_WRITE_BYTES, decodeFrameMessage, frameRequest } from "./requests.js";
import { MAX_FRAME_PATH_LENGTH, decodeFrameEntries, decodeFrameFile, encodeFileEntry, encodeWorkspaceChanges, watchedDirectories } from "./workspace.js";

function code(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof VMError) return error.code; throw error; }
  throw new Error("expected a VMError");
}

const v = FRAME_PROTOCOL_VERSION;
const version = "0123456789abcdef0123456789abcdef0123456789abcdef";
const file: WorkspaceFileEntry = { kind: "file", link: null, name: "a.txt", path: "/src/a.txt", size: 2, version };
const link: WorkspaceFileEntry = { kind: "symlink", link: { kind: "directory", path: "/src" }, name: "s", path: "/s", size: 4, version };

describe("workspace frame requests", () => {
  it("round-trips every workspace request with the fields the page sent", () => {
    const data = new Uint8Array([1, 2]);
    const cases = [
      { type: "workspace.entries", path: "/src" },
      { type: "workspace.stat", path: "/a" },
      { type: "workspace.createDirectory", path: "/d" },
      { type: "workspace.readEntry", path: "/a" },
      { type: "workspace.readEntry", path: "/a", maxBytes: 0 },
      { type: "workspace.writeEntry", path: "/a", data },
      { type: "workspace.writeEntry", path: "/a", data, ifVersion: null },
      { type: "workspace.writeEntry", path: "/a", data, ifVersion: version },
      { type: "workspace.rename", from: "/a", to: "/b" },
      { type: "workspace.watch" },
      { type: "workspace.watch.setDirectories", watch: 4, directories: ["/", "/src"] },
    ] as const;
    for (const operation of cases) expect(decodeFrameMessage(frameRequest(9, operation))).toEqual({ ...operation, id: 9 });
  });

  it.each([
    { name: "a missing path", message: { v, id: 1, type: "workspace.stat" } },
    { name: "an extra field", message: { v, id: 1, type: "workspace.entries", path: "/", recursive: true } },
    { name: "a non-string path", message: { v, id: 1, type: "workspace.createDirectory", path: 7 } },
    { name: "an oversize path", message: { v, id: 1, type: "workspace.stat", path: "a".repeat(MAX_FRAME_PATH_LENGTH + 1) } },
    { name: "a negative read limit", message: { v, id: 1, type: "workspace.readEntry", path: "/a", maxBytes: -1 } },
    { name: "a read limit over 16 MiB", message: { v, id: 1, type: "workspace.readEntry", path: "/a", maxBytes: MAX_WORKSPACE_FILE_BYTES + 1 } },
    { name: "a fractional read limit", message: { v, id: 1, type: "workspace.readEntry", path: "/a", maxBytes: 1.5 } },
    { name: "text instead of bytes", message: { v, id: 1, type: "workspace.writeEntry", path: "/a", data: "x" } },
    { name: "a write without bytes", message: { v, id: 1, type: "workspace.writeEntry", path: "/a" } },
    { name: "a malformed version", message: { v, id: 1, type: "workspace.writeEntry", path: "/a", data: new Uint8Array(1), ifVersion: "abc" } },
    { name: "a numeric version", message: { v, id: 1, type: "workspace.writeEntry", path: "/a", data: new Uint8Array(1), ifVersion: 1 } },
    { name: "a rename without a target", message: { v, id: 1, type: "workspace.rename", from: "/a" } },
    { name: "a watch with fields", message: { v, id: 1, type: "workspace.watch", path: "/" } },
    { name: "a watch id of zero", message: { v, id: 1, type: "workspace.watch.setDirectories", watch: 0, directories: [] } },
    { name: "directories that are not a list", message: { v, id: 1, type: "workspace.watch.setDirectories", watch: 1, directories: "/" } },
    { name: "a non-string directory", message: { v, id: 1, type: "workspace.watch.setDirectories", watch: 1, directories: [1] } },
    { name: "too many directories", message: { v, id: 1, type: "workspace.watch.setDirectories", watch: 1, directories: Array.from({ length: 257 }, (_, index) => `/d${String(index)}`) } },
    { name: "the previous protocol version", message: { v: 1, id: 1, type: "workspace.watch" } },
  ])("rejects $name", ({ message }) => {
    expect(code(() => decodeFrameMessage(message))).toBe("PROTOCOL_ERROR");
  });

  it("bounds workspace writes like plain writes", () => {
    const decoded = decodeFrameMessage(frameRequest(1, { type: "workspace.writeEntry", path: "/a", data: new Uint8Array(MAX_WORKSPACE_FILE_BYTES + 1) }));
    expect(decoded).toMatchObject({ type: "workspace.writeEntry" });
    expect(MAX_FRAME_WRITE_BYTES).toBeGreaterThan(MAX_WORKSPACE_FILE_BYTES);
  });

  it("removes duplicate watched directories and refuses more than a VM may watch with the VM's own error", () => {
    expect(watchedDirectories(["/a", "/a", "/b"])).toEqual(["/a", "/b"]);
    expect(code(() => watchedDirectories(Array.from({ length: 257 }, (_, index) => `/d${String(index)}`)))).toBe("INVALID_ARGUMENT");
  });
});

describe("workspace frame values", () => {
  it("decodes entries and refuses entries that are not exact", () => {
    expect(decodeFrameEntries([file, link].map(encodeFileEntry))).toEqual([file, link]);
    expect(code(() => decodeFrameEntries({ entries: [] }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameEntries([{ ...file, extra: 1 }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameEntries([{ ...file, version: "x" }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameEntries([{ ...file, size: -1 }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameEntries([{ ...file, name: "b.txt" }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameEntries([{ ...file, link: { kind: "file", path: "/x" } }]))).toBe("PROTOCOL_ERROR");
  });

  it("keeps only an entry's wire fields", () => {
    expect(encodeFileEntry({ ...file, ...{ cached: true } })).toEqual(file);
  });

  it("decodes a bounded read and refuses bytes that do not match its entry or exceed the page's limit", () => {
    const data = new Uint8Array([104, 105]);
    expect(decodeFrameFile({ entry: file, data }, 2)).toEqual({ entry: file, data });
    expect(code(() => decodeFrameFile({ entry: file, data }, 1))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameFile({ entry: file, data: new Uint8Array(3) }, 10))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameFile({ entry: { ...file, kind: "directory", size: 0 }, data: new Uint8Array(0) }, 10))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameFile({ entry: file, data: [104, 105] }, 10))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameFile({ entry: file, data, extra: true }, 10))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameFile({ entry: file }, 10))).toBe("PROTOCOL_ERROR");
  });

  it("carries change batches exactly and collapses an oversize batch into a rescan", () => {
    const changes: WorkspaceChange[] = [{ kind: "changed", directory: "/src", name: "a.txt" }, { kind: "rescan" }];
    expect(decodeWorkspaceChanges(encodeWorkspaceChanges(changes))).toEqual(changes);
    const many: WorkspaceChange[] = Array.from({ length: MAX_WORKSPACE_CHANGES + 1 }, (_, index) => ({ kind: "changed", directory: "/", name: `f${String(index)}` }));
    expect(encodeWorkspaceChanges(many)).toEqual([{ kind: "rescan" }]);
    expect(code(() => decodeWorkspaceChanges(many))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeWorkspaceChanges([{ kind: "changed", directory: "/src", name: "a", extra: 1 }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeWorkspaceChanges([{ kind: "changed", directory: "src", name: "a" }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeWorkspaceChanges([{ kind: "changed", directory: "/", name: "a/b" }]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeWorkspaceChanges([{ kind: "deleted" }]))).toBe("PROTOCOL_ERROR");
  });
});
