import { expect, it } from "vitest";
import { createGuestModules } from "./guest-modules.ts";

const root = "/workspace/node_modules";
function fixture(runtime: "node" | "bun" = "node", moduleSearchPaths = [`${root}/.pnpm/missing`, `${root}/.pnpm/node_modules`, `${root}/extra`]) {
  const sources = new Map([
    [`${root}/.pnpm/node_modules/only/package.json`, '{"main":"index.js"}'],
    [`${root}/.pnpm/node_modules/only/index.js`, "module.exports = 1"],
    [`${root}/extra/only/index.js`, "module.exports = 2"],
  ]);
  const files = {
    readFileSync(path: string): string {
      const value = sources.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    statSync(path: string) {
      return { isFile: () => sources.has(path), isDirectory: () => Array.from(sources.keys()).some(key => key.startsWith(`${path}/`)) };
    },
    realpathSync(path: string): string {
      if (!sources.has(path) && !Array.from(sources.keys()).some(key => key.startsWith(`${path}/`))) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
  };
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: root }], runtime, moduleSearchPaths } as const;
  return { sources, files, modules: createGuestModules(files, identity) };
}

it("resolves pnpm NODE_PATH roots after ordinary module locations, preserving order and missing roots", () => {
  const { modules, sources } = fixture();
  expect(modules.resolve("only", "/workspace/app.cjs", "require")).toBe(`${root}/.pnpm/node_modules/only/index.js`);
  sources.set(`${root}/only.js`, "module.exports = 'local'");
  expect(modules.resolve("only", "/workspace/app.cjs", "require")).toBe(`${root}/only.js`);
});

it("keeps Node ESM independent of NODE_PATH while Bun imports use its runtime search roots", () => {
  expect(() => fixture("node").modules.resolve("only", "/workspace/app.mjs", "import")).toThrow("Cannot find module");
  expect(fixture("bun").modules.resolve("only", "/workspace/app.mjs", "import")).toBe(`${root}/.pnpm/node_modules/only/index.js`);
});

it("keeps additional search roots private to each admitted process", () => {
  expect(() => fixture("node", []).modules.resolve("only", "/workspace/app.cjs", "require")).toThrow();
  expect(fixture("node", [`${root}/extra`]).modules.resolve("only", "/workspace/app.cjs", "require")).toBe(`${root}/extra/only/index.js`);
});

it("fences search-root symlinks into installed code outside every root", () => {
  const { modules, files } = fixture();
  files.realpathSync = () => "/workspace/elsewhere/node_modules/only/index.js";
  expect(() => modules.resolve("only", "/workspace/app.cjs", "require")).toThrow("dependency generation");
});
