import { describe, expect, it } from "vitest";
import { createNodeFilesMore } from "./node-files-more.js";
import { Dirent } from "./node-file-operations.js";

function fakeTree() {
  const files = new Map<string, Uint8Array>([["/src/a.txt", new TextEncoder().encode("alpha")], ["/src/sub/b.txt", new TextEncoder().encode("beta")]]);
  const dirs = new Set<string>(["/src", "/src/sub", "/tmp"]);
  const promises = {
    readdir(path: unknown, options?: unknown) {
      const prefix = `${String(path)}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] ?? "");
      const entries = [...names].filter(name => name !== "").sort();
      if (typeof options === "object" && options !== null && Reflect.get(options, "withFileTypes") === true) {
        return Promise.resolve(entries.map(name => new Dirent(name, dirs.has(`${prefix}${name}`) ? 4 : 8, String(path))));
      }
      return Promise.resolve(entries);
    },
    readFile(path: unknown) { const bytes = files.get(String(path)); return bytes === undefined ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) : Promise.resolve(bytes); },
    writeFile(path: unknown, data: unknown) { files.set(String(path), data instanceof Uint8Array ? data : new TextEncoder().encode(typeof data === "string" ? data : "")); return Promise.resolve(); },
    mkdir(path: unknown, options?: unknown) {
      const target = String(path);
      if (dirs.has(target)) { if (typeof options === "object" && options !== null && Reflect.get(options, "recursive") === true) return Promise.resolve(undefined); return Promise.reject(Object.assign(new Error("EEXIST"), { code: "EEXIST" })); }
      dirs.add(target); return Promise.resolve(target);
    },
    stat(path: unknown) { const key = String(path); if (dirs.has(key)) return Promise.resolve({ isDirectory: () => true, isFile: () => false, size: 0 }); const bytes = files.get(key); if (bytes === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })); return Promise.resolve({ isDirectory: () => false, isFile: () => true, size: bytes.byteLength }); },
    lstat(path: unknown) { return this.stat(path); },
  };
  return { files, dirs, promises };
}

describe("fs additions", () => {
  it("cp copies a tree recursively and mkdtemp creates a uniquely suffixed directory", async () => {
    const tree = fakeTree();
    const more = createNodeFilesMore(tree.promises);
    await more.promises.cp("/src", "/dest", { recursive: true });
    expect(new TextDecoder().decode(tree.files.get("/dest/a.txt"))).toBe("alpha");
    expect(new TextDecoder().decode(tree.files.get("/dest/sub/b.txt"))).toBe("beta");
    await expect(more.promises.cp("/src", "/dest2")).rejects.toMatchObject({ code: "ERR_FS_EISDIR" });
    const made = await more.promises.mkdtemp("/tmp/next-");
    expect(made).toMatch(/^\/tmp\/next-[A-Za-z0-9]{6}$/u);
    expect(tree.dirs.has(made)).toBe(true);
  });

  it("iterates actual directory entries and closes the iterator after early return", async () => {
    const tree = fakeTree(), more = createNodeFilesMore(tree.promises);
    const directory = await more.promises.opendir("/src");
    expect(directory.path).toBe("/src");
    const names: string[] = [];
    for await (const entry of directory) { names.push(entry.name); }
    expect(names).toEqual(["a.txt", "sub"]);
    await expect(directory.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
    const early = await more.promises.opendir("/src");
    for await (const entry of early) { expect(entry.isFile()).toBe(true); break; }
    await expect(early.close()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
  });
});
