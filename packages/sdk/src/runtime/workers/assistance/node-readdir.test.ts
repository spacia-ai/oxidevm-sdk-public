import { expect, it } from "vitest";
import { createSyncFiles, createAsyncFiles } from "./node-files.js";
import { createAsyncContext } from "./async-context.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

const entries = [{ name: "link", mode: 0o120000 }, { name: "file", mode: 0o100000 }, { name: "directory", mode: 0o040000 }];
function linux(operation: AssistanceOperation): AssistanceResult {
  if (operation.kind === "readdir-entries") return { kind: "entries", entries };
  if (operation.kind === "readdir") return { kind: "names", names: entries.map(entry => entry.name) };
  throw new Error("Directory entries must not be reconstructed with pathname stat calls");
}

it("exposes Linux Dirents and preserves the caller's parent path", () => {
  const fs = createSyncFiles(linux, () => "/workspace");
  expect(new fs.Dirent("entry", 4, ".").isDirectory()).toBe(true);
  const result = fs.readdirSync("./routes/", { withFileTypes: true });
  expect(result.map(entry => typeof entry === "string" ? entry : entry.name)).toEqual(["directory", "file", "link"]);
  for (const entry of result) {
    expect(entry).toBeInstanceOf(fs.Dirent);
    if (typeof entry === "string") throw new Error("missing Dirent");
    expect(entry.parentPath).toBe("./routes/");
    expect(entry.isDirectory()).toBe(entry.name === "directory");
    expect(entry.isFile()).toBe(entry.name === "file");
    expect(entry.isSymbolicLink()).toBe(entry.name === "link");
    expect(entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()).toBe(false);
  }
  expect(fs.readdirSync(".", "utf8")).toEqual(["directory", "file", "link"]);
});

it("delivers directory metadata through promises and callbacks", async () => {
  const fs = createAsyncFiles(operation => Promise.resolve(linux(operation)), () => "/workspace", createAsyncContext(), () => () => {});
  const result = await fs.promises.readdir("routes", { withFileTypes: true });
  expect(result).toHaveLength(3);
  const completion = Promise.withResolvers<unknown[]>();
  fs.readdir("routes", { withFileTypes: true }, (...args: unknown[]) => { completion.resolve(args); });
  expect(await completion.promise).toEqual([null, result]);
});


it("reports Node scandir errors for both names and typed entries", async () => {
  const failure = (operation: AssistanceOperation): AssistanceResult => ({ kind: "error", code: "ENOENT", errno: 2, syscall: "readdir", path: "path" in operation ? operation.path : null, destination: null });
  const sync = createSyncFiles(failure, () => "/workspace");
  const async = createAsyncFiles(operation => Promise.resolve(failure(operation)), () => "/workspace", createAsyncContext(), () => () => {});
  for (const options of [undefined, { withFileTypes: true }]) {
    let failure: unknown;
    try { sync.readdirSync("missing", options); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "ENOENT", syscall: "scandir", path: "missing" });
    await expect(async.promises.readdir("missing", options)).rejects.toMatchObject({ code: "ENOENT", syscall: "scandir", path: "missing" });
  }
});
