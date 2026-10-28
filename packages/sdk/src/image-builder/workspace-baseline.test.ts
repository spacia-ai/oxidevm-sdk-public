import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { encodeWorkspaceBaseline } from "./workspace-baseline.js";
import { hash } from "./files.js";
import type { UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";

const owner = { uid: 123, gid: 456 };
const blob = hash("hello");
const blobs = [{ sha256: blob, bytes: 5, url: new URL("https://fixture.invalid/hello") }];
const entries: readonly UserspaceRootfsEntry[] = [
  { path: "opt/content", type: "file", mode: 0o640, ownership: owner, blob },
  { path: "workspace", type: "directory", mode: 0o750, ownership: owner },
  { path: "workspace/alias", type: "hardlink", mode: 0o640, ownership: owner, target: "opt/content" },
  { path: "workspace/link", type: "symlink", mode: 0o777, ownership: owner, target: "note" },
  { path: "workspace/note", type: "file", mode: 0o640, ownership: owner, blob },
  { path: "workspace/żółw", type: "directory", mode: 0o700, ownership: owner },
];

it("matches the native agent's OXWB fixture with guest ownership, digests, links and UTF-8 ordering", async () => {
  const fixture = (await readFile(new URL("../../../../tests/fixtures/images/workspace-baseline-v3.hex", import.meta.url), "utf8")).trim();
  expect(Buffer.from(encodeWorkspaceBaseline([...entries].reverse(), blobs, "workspace", 1785369600)).toString("hex")).toBe(fixture);
});

it("rejects timestamps outside the signed native range and incomplete file metadata", () => {
  for (const epoch of [-1, 0.5, Number.NaN, 9_223_372_037]) expect(() => encodeWorkspaceBaseline(entries, blobs, "workspace", epoch)).toThrow();
  expect(() => encodeWorkspaceBaseline(entries, [], "workspace", 0)).toThrow("file size");
  expect(() => encodeWorkspaceBaseline(entries.slice(1), blobs, "workspace", 0)).toThrow("hardlink target");
  expect(() => encodeWorkspaceBaseline(entries, blobs, "absent", 0)).toThrow("guest directory");
});
