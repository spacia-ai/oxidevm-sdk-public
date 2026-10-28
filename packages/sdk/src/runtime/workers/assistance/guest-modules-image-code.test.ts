import { expect, it } from "vitest";
import { createGuestModules } from "./guest-modules.js";
import { decodeNativeRoots, readNativeRoots } from "../../userspace-command-abi.js";
import { Reader, Writer } from "../../js-process/codec.js";

it("loads an immutable image package, hidden helpers and its own dependencies", () => {
  const root = "/usr/lib/node_modules/tool";
  const sources = new Map([
    [`${root}/package.json`, '{"type":"module","main":".hidden.cjs"}'],
    [`${root}/main.mjs`, "export default 1"],
    [`${root}/.hidden.cjs`, "module.exports = 1"],
    [`${root}/.hidden/package.json`, '{"name":"hidden","exports":"./main.cjs"}'],
    [`${root}/.hidden/main.cjs`, "module.exports = 3"],
    [`${root}/node_modules/dep/package.json`, '{"main":"index.js"}'],
    [`${root}/node_modules/dep/index.js`, "module.exports = 2"],
  ]);
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const files = {
    readFileSync: (path: string) => sources.get(path) ?? (() => { throw missing(); })(),
    realpathSync: (path: string) => path,
    statSync: (path: string) => ({ isFile: () => sources.has(path), isDirectory: () => [...sources.keys()].some(key => key.startsWith(path + "/")) }),
  };
  const roots = [{ kind: "image", path: root, sha256: "a".repeat(64) }] as const;
  const modules = createGuestModules(files, { generation: 1n, profile: "node24-bun1-v1", roots, runtime: "node", moduleSearchPaths: [] });
  expect(modules.read(`${root}/main.mjs`).format).toBe("module");
  expect(modules.read(`${root}/.hidden.cjs`).format).toBe("commonjs");
  expect(modules.resolve("dep", `${root}/main.mjs`, "require")).toBe(`${root}/node_modules/dep/index.js`);
  expect(modules.resolve("hidden", `${root}/.hidden/main.cjs`, "require")).toBe(`${root}/.hidden/main.cjs`);
  expect(modules.resolve(root, "/workspace/main.cjs", "require")).toBe(`${root}/.hidden.cjs`);
  expect(() => modules.resolve(root, "/workspace/main.mjs", "import")).toThrow("Directory import");
  expect(() => modules.read("/usr/lib/undeclared.js")).toThrow(/code roots/u);
  expect(() => modules.read(`${root}-other/main.js`)).toThrow(/dependency generation/u);
  const escaping = createGuestModules({ ...files, realpathSync: () => "/etc/escape.js" }, modules.dependencies);
  expect(() => escaping.read(`${root}/main.mjs`)).toThrow(/code roots/u);
});

it("decodes image-root content identities and rejects forged or overlapping roots", () => {
  const bytes = new Writer().u32(1).u8(2).path("/usr/local/lib/tool").raw(new Uint8Array(32).fill(0xab)).finish();
  const roots = readNativeRoots(new Reader(bytes));
  expect(roots).toEqual([{ kind: "image", path: "/usr/local/lib/tool", sha256: "ab".repeat(32) }]);
  for (const input of [
    [{ kind: "image", path: "/usr/lib/tool" }],
    [{ kind: "image", path: "/workspace/tool", sha256: "a".repeat(64) }],
    [{ kind: "image", path: "/workspace", sha256: "a".repeat(64) }],
    [{ kind: "image", path: "/usr/lib/../tool", sha256: "a".repeat(64) }],
    [...roots, ...roots],
    [...roots, { kind: "image", path: "/usr/local/lib/tool/nested", sha256: "b".repeat(64) }],
  ]) expect(() => decodeNativeRoots(input)).toThrow();
  expect(() => readNativeRoots(new Reader(bytes.subarray(0, bytes.length - 1)))).toThrow();
});
