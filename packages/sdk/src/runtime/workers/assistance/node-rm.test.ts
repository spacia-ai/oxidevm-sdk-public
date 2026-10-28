import * as native from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createSyncFiles, createAsyncFiles } from "./node-files.js";
import { createAsyncContext } from "./async-context.js";

function failure(run: () => unknown): unknown { try { run(); } catch (error) { return error; } throw new Error("Expected failure"); }

function linux(operation: AssistanceOperation): AssistanceResult {
  if (!["lstat", "readdir", "unlink", "rmdir"].includes(operation.kind) || !("path" in operation)) throw new Error("Unexpected operation");
  try {
    if (operation.kind === "lstat") {
      const s = native.lstatSync(operation.path, { bigint: true });
      return { kind: "stat", stat: { dev: s.dev, ino: s.ino, nlink: s.nlink, size: s.size, blocks: s.blocks, mode: Number(s.mode), uid: Number(s.uid), gid: Number(s.gid), blksize: Number(s.blksize), atimeNs: s.atimeNs, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs, details: null } };
    }
    if (operation.kind === "readdir") return { kind: "names", names: native.readdirSync(operation.path) };
    if (operation.kind === "unlink") native.unlinkSync(operation.path);
    else native.rmdirSync(operation.path);
    return { kind: "unit" };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !("errno" in error) || typeof error.errno !== "number") throw error;
    return { kind: "error", code: error.code, errno: -error.errno, syscall: operation.kind, path: operation.path, destination: null };
  }
}

it("removes a real tree without following symlinks and preserves force/error behavior in all fs forms", async () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-rm-")), sync = createSyncFiles(linux, () => root);
  const async = createAsyncFiles(operation => Promise.resolve(linux(operation)), () => root, createAsyncContext(), () => () => {});
  try {
    const outside = join(root, "outside"); native.mkdirSync(outside); native.writeFileSync(join(outside, "keep"), "safe");
    for (const remove of [(path: string) => Promise.resolve().then(() => { sync.rmSync(path, { recursive: true }); }), async (path: string) => { await async.promises.rm(path, { recursive: true }); }, (path: string) => new Promise<void>((resolve, reject) => { async.rm(path, { recursive: true }, (error: Error | null | undefined) => { if (error !== null && error !== undefined) reject(error); else resolve(); }); })]) {
      const tree = join(root, "tree"); native.mkdirSync(join(tree, "nested"), { recursive: true }); native.writeFileSync(join(tree, "nested/file"), "data"); native.symlinkSync(outside, join(tree, "link"));
      await remove(tree); expect(native.existsSync(tree)).toBe(false); expect(native.readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
    }
    sync.rmSync(join(root, "absent"), { force: true });
    await expect(async.promises.rm(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure(() => sync.rmSync(outside))).toMatchObject({ code: "ERR_FS_EISDIR", errno: 21 });
    await expect(async.promises.rm(join(outside, "keep/child"), { force: true })).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(() => sync.rmSync(outside, { recursive: true, maxRetries: 1 })).toThrow(/not qualified/u);
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});
