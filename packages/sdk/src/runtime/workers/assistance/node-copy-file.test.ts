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
  if (operation.kind !== "open" && operation.kind !== "close" && operation.kind !== "fstat" && operation.kind !== "read" && operation.kind !== "write" && operation.kind !== "ftruncate" && operation.kind !== "fchmod" && operation.kind !== "unlink") throw new Error("Unexpected operation");
  try {
    switch (operation.kind) {
      case "open": return { kind: "opened", fd: native.openSync(operation.path, operation.flags === 10 ? native.constants.O_WRONLY | native.constants.O_CREAT : operation.flags === 0 ? "r" : "wx", operation.mode) };
      case "close": native.closeSync(operation.fd); break;
      case "fstat": {
        const s = native.fstatSync(operation.fd, { bigint: true });
        return { kind: "stat", stat: { dev: s.dev, ino: s.ino, nlink: s.nlink, size: s.size, blocks: s.blocks, mode: Number(s.mode), uid: Number(s.uid), gid: Number(s.gid), blksize: Number(s.blksize), atimeNs: s.atimeNs, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs, details: null } };
      }
      case "read": { const bytes = new Uint8Array(operation.length), count = native.readSync(operation.fd, bytes, 0, bytes.length, null); return { kind: "data", bytes: bytes.slice(0, count) }; }
      case "write": return { kind: "written", count: native.writeSync(operation.fd, operation.bytes, 0, Math.min(operation.bytes.length, 7000), null) };
      case "ftruncate": native.ftruncateSync(operation.fd, Number(operation.length)); break;
      case "fchmod": native.fchmodSync(operation.fd, operation.mode); break;
      case "unlink": native.unlinkSync(operation.path); break;
      default: throw new Error("Unexpected operation");
    }
    return { kind: "unit" };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !("errno" in error) || typeof error.errno !== "number") throw error;
    return { kind: "error", code: error.code, errno: -error.errno, syscall: operation.kind, path: "path" in operation ? operation.path : null, destination: null };
  }
}

it("copies bounded partial writes, modes and aliases through all fs forms without truncating its source", async () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-copy-")), source = join(root, "source"), target = join(root, "target");
  const sync = createSyncFiles(linux, () => root, 10), callbacks = createAsyncFiles(operation => Promise.resolve(linux(operation)), () => root, createAsyncContext(), () => () => {}, undefined, 10);
  try {
    const bytes = Buffer.alloc(150000, 42);
    native.writeFileSync(source, bytes); native.chmodSync(source, 0o751);
    sync.copyFileSync(source, target); expect(native.readFileSync(target)).toEqual(bytes); expect(native.statSync(target).mode & 0o777).toBe(0o751);
    native.chmodSync(target, 0o200); await callbacks.promises.copyFile(source, target); expect(native.readFileSync(target)).toEqual(bytes);
    native.linkSync(source, join(root, "alias")); sync.copyFileSync(source, join(root, "alias")); expect(native.readFileSync(source)).toEqual(bytes);
    expect(failure(() => sync.copyFileSync(source, target, 1))).toMatchObject({ code: "EEXIST", syscall: "copyfile", path: source, dest: target });
    await new Promise<void>((resolve, reject) => { callbacks.copyFile(source, target, (error: Error | null | undefined) => { if (error !== null && error !== undefined) reject(error); else resolve(); }); });
    expect(() => createSyncFiles(() => { throw new Error("Unexpected effect"); }, () => root).copyFileSync(source, target)).toThrow(/not qualified/u);
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});


it("closes both descriptions and removes a partial destination after a failed copy", () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-copy-failed-")), source = join(root, "source"), target = join(root, "target");
  const live = new Set<number>();
  const fs = createSyncFiles(operation => {
    if (operation.kind === "write") return { kind: "error", errno: 28, code: "ENOSPC", syscall: "write", path: null, destination: null };
    const result = linux(operation);
    if (result.kind === "opened") live.add(result.fd);
    if (operation.kind === "close" && result.kind === "unit") live.delete(operation.fd);
    return result;
  }, () => root, 10);
  try {
    native.writeFileSync(source, "source");
    expect(failure(() => fs.copyFileSync(source, target))).toMatchObject({ code: "ENOSPC", syscall: "copyfile", path: source, dest: target });
    expect(live.size).toBe(0); expect(native.existsSync(target)).toBe(false); expect(native.readFileSync(source, "utf8")).toBe("source");
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});
