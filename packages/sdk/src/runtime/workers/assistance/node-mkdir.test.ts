import * as native from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSyncFiles, createAsyncFiles } from "./node-files.js";
import { createAsyncContext } from "./async-context.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

// The adapter executes single Linux operations. Only the reference side uses
// Node's recursive implementation, so it cannot implement the behavior tested.
function linux(operation: AssistanceOperation): AssistanceResult {
  if (operation.kind !== "mkdir" && operation.kind !== "stat") throw new Error("unexpected operation");
  try {
    if (operation.kind === "mkdir") {
      native.mkdirSync(operation.path, { mode: operation.mode });
      return { kind: "unit" };
    }
    const value = native.statSync(operation.path, { bigint: true });
    return { kind: "stat", stat: {
      details: { rdev: value.rdev, birthtimeNs: value.birthtimeNs },
      dev: value.dev, ino: value.ino, nlink: value.nlink, size: value.size, blocks: value.blocks,
      mode: Number(value.mode), uid: Number(value.uid), gid: Number(value.gid), blksize: Number(value.blksize),
      atimeNs: value.atimeNs, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs,
    } };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string"
      || !("errno" in error) || typeof error.errno !== "number") throw error;
    return { kind: "error", errno: -error.errno, code: error.code, syscall: operation.kind, path: operation.path, destination: null };
  }
}

it("matches Node recursive mkdir paths, existing directories, symlinks and conflicts", () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-mkdir-"));
  const actual = join(root, "actual"); const reference = join(root, "reference");
  const fs = createSyncFiles(linux, () => actual);
  for (const base of [actual, reference]) {
    native.mkdirSync(base);
    native.writeFileSync(join(base, "file"), "x");
    native.symlinkSync("missing-target", join(base, "dangling"));
  }
  try {
    for (const name of ["a/b", "a/b", "./c/d", "e/../f", "g//h///", "missing/./child", "file/child", "file", "dangling/child", "."]) {
      const observe = (base: string, mkdir: (path: string) => unknown) => {
        try { const value = mkdir(`${base}/${name}`); return typeof value === "string" ? value.replace(base, "ROOT") : value; }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error)) throw error;
          return { code: error.code, path: "path" in error && typeof error.path === "string" ? error.path.replace(base, "ROOT") : null };
        }
      };
      expect(observe(actual, path => fs.mkdirSync(path, { recursive: true })), name)
        .toEqual(observe(reference, path => native.mkdirSync(path, { recursive: true })));
    }
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});

it("returns the first created path through promises and the recursive callback", async () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-mkdir-async-"));
  const fs = createAsyncFiles(operation => Promise.resolve(linux(operation)), () => root, createAsyncContext(), () => () => {});
  try {
    expect(await fs.promises.mkdir(`${root}/promise/child`, { recursive: true, mode: "750" })).toBe(`${root}/promise`);
    const result = Promise.withResolvers<unknown[]>();
    fs.mkdir(`${root}/callback/child`, { recursive: true }, (...args: unknown[]) => { result.resolve(args); });
    expect(await result.promise).toEqual([null, `${root}/callback`]);
    const nonrecursive = Promise.withResolvers<unknown[]>();
    fs.mkdir(`${root}/single`, (...args: unknown[]) => { nonrecursive.resolve(args); });
    expect(await nonrecursive.promise).toEqual([null]);
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});


it("matches asynchronous Node errors and captures callback options once", async () => {
  const root = native.mkdtempSync(join(tmpdir(), "oxidevm-mkdir-errors-"));
  const fs = createAsyncFiles(operation => Promise.resolve(linux(operation)), () => root, createAsyncContext(), () => () => {});
  try {
    native.symlinkSync("absent", `${root}/link`);
    for (const name of ["link", "link/child"]) {
      const path = `${root}/${name}`;
      const expected = await native.promises.mkdir(path, { recursive: true }).catch((error: unknown) => error);
      expect(expected).toBeInstanceOf(Error);
      if (!(expected instanceof Error) || !("code" in expected) || !("path" in expected)) throw expected;
      await expect(fs.promises.mkdir(path, { recursive: true })).rejects.toMatchObject({ code: expected.code, path: expected.path, syscall: "mkdir" });
    }
    let reads = 0;
    const completion = Promise.withResolvers<unknown[]>();
    fs.mkdir(`${root}/captured`, { get recursive() { reads += 1; return true; } }, (...args: unknown[]) => { completion.resolve(args); });
    expect(await completion.promise).toEqual([null, `${root}/captured`]);
    expect(reads).toBe(1);
    const existing = Promise.withResolvers<unknown[]>();
    fs.mkdir(root, { recursive: true }, (...args: unknown[]) => { existing.resolve(args); });
    expect(await existing.promise).toEqual([null, undefined]);
    for (const options of [{ recursive: 1 }, { recursive: null }, { mode: "0o755" }, { mode: -1 }, { mode: 1.5 }]) {
      let expected: unknown;
      try { Reflect.apply(native.mkdirSync, native, [`${root}/invalid`, options]); } catch (error) { expected = error; }
      if (!(expected instanceof Error) || !("code" in expected)) throw new Error("Node accepted invalid options");
      await expect(fs.promises.mkdir(`${root}/invalid`, options)).rejects.toMatchObject({ code: expected.code });
    }
  } finally { native.rmSync(root, { recursive: true, force: true }); }
});
