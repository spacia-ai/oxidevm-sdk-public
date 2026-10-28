import { describe, expect, it } from "vitest";
import { createGuestModules } from "./guest-modules.ts";

function fixture() {
  const sources = new Map([
    ["/workspace/main.cjs", "require('./local')"],
    ["/workspace/local.js", "module.exports = 7"],
    ["/workspace/package.json", '{"type":"commonjs"}'],
    ["/workspace/esm/package.json", '{"type":"module"}'],
    ["/workspace/esm/value.js", "export const value = 8"],
    ["/workspace/data.json", '{"value":9}'],
  ]);
  const files = {
    readFileSync(path: string): string {
      const value = sources.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    statSync(path: string) {
      if (!sources.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isDirectory: () => false };
    },
    realpathSync(path: string): string { return path; },
  };
  return { sources, files, modules: createGuestModules(files) };
}

describe("Linux-backed local modules", () => {
  it("resolves CJS extensions and package type through fresh authoritative reads", () => {
    const { modules, sources } = fixture();
    expect(modules.resolve("./local", "/workspace/main.cjs", "require")).toBe("/workspace/local.js");
    expect(modules.read("/workspace/local.js")).toEqual({ source: "module.exports = 7", format: "commonjs" });
    expect(modules.read("/workspace/esm/value.js").format).toBe("module");
    expect(modules.read("/workspace/data.json").format).toBe("json");
    sources.set("/workspace/local.js", "module.exports = 10");
    expect(modules.read("/workspace/local.js").source).toBe("module.exports = 10");
  });

  it("requires exact ESM filenames and rejects package paths after realpath", () => {
    const { files, modules } = fixture();
    expect(() => modules.resolve("./local", "/workspace/main.cjs", "import")).toThrow();
    expect(modules.resolve("./local.js", "/workspace/main.cjs", "import")).toBe("/workspace/local.js");
    expect(() => modules.resolve("some-package", "/workspace/main.cjs", "require")).toThrow();
    files.realpathSync = () => "/workspace/node_modules/package/index.js";
    expect(() => modules.resolve("./local.js", "/workspace/main.cjs", "require")).toThrow("installed-package");
  });

  it("does not turn permission failures into missing modules", () => {
    const { files, modules } = fixture();
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    files.statSync = () => { throw denied; };
    expect(() => modules.resolve("./local", "/workspace/main.cjs", "require")).toThrow(denied);
  });

  it("resolves a local directory main without treating a missing addon as installed code", () => {
    const { files, modules, sources } = fixture();
    const original = files.statSync.bind(files);
    files.statSync = path => path === "/workspace/dir"
      ? { isFile: () => false, isDirectory: () => true } : original(path);
    sources.set("/workspace/dir/package.json", '{"main":"entry"}');
    sources.set("/workspace/dir/entry.js", "module.exports = 3");
    expect(modules.resolve("./dir", "/workspace/main.cjs", "require")).toBe("/workspace/dir/entry.js");
  });
});

it("loads editable project modules while fencing installed modules to the admitted dependency generation", () => {
  const { files, sources } = fixture();
  const modules = createGuestModules(files, { generation: 11n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] });
  sources.set("/workspace/node_modules/installed.js", "module.exports = 12");
  sources.set("/workspace/other/node_modules/outside.js", "module.exports = 99");
  expect(modules.read("/workspace/node_modules/installed.js").source).toBe("module.exports = 12");
  sources.set("/workspace/local.js", "module.exports = 13");
  expect(modules.read("/workspace/local.js").source).toBe("module.exports = 13");
  expect(() => modules.read("/workspace/other/node_modules/outside.js")).toThrow(/dependency generation/u);
});

it("follows links Rust classified while refusing installed code outside every root", () => {
  const { files, sources } = fixture();
  sources.set("/workspace/node_modules/helper.js", "module.exports = 1");
  sources.set("/workspace/node_modules/pkg/package.json", '{"main":"../../local.js"}');
  sources.set("/workspace/local.js", "module.exports = 2");
  const exists = (path: string) => sources.has(path) || Array.from(sources.keys()).some(key => key.startsWith(`${path}/`));
  files.statSync = path => {
    if (!exists(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => sources.has(path), isDirectory: () => !sources.has(path) };
  };
  const modules = createGuestModules(files, { generation: 11n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] });
  const link = (target: string) => (path: string) => {
    if (!exists(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return path === "/workspace/node_modules/helper.js" ? target : path;
  };
  files.realpathSync = link("/workspace/local.js");
  expect(modules.resolve("helper", "/workspace/main.cjs", "require")).toBe("/workspace/local.js");
  expect(modules.resolve("pkg", "/workspace/main.cjs", "require")).toBe("/workspace/local.js");
  files.realpathSync = link("/workspace/other/node_modules/helper.js");
  expect(() => modules.resolve("helper", "/workspace/main.cjs", "require")).toThrow(/dependency generation/u);
});

it("admits every root Rust published in order, monorepo and store roots included", () => {
  const { files, sources } = fixture();
  const roots = [
    { kind: "dependencies", path: "/workspace/repo/apps/web/node_modules" },
    { kind: "dependencies", path: "/workspace/repo/node_modules" },
    { kind: "store", path: "/home/user/store/links/dep/1/abc/node_modules" },
  ] as const;
  const modules = createGuestModules(files, { generation: 11n, profile: "node24-bun1-v1", roots, runtime: "node", moduleSearchPaths: [] });
  for (const path of ["/workspace/repo/apps/web/node_modules/local/index.js", "/workspace/repo/node_modules/.pnpm/dep@1/node_modules/dep/index.js", "/workspace/repo/node_modules/.bun/dep@1/node_modules/dep/index.js", "/home/user/store/links/dep/1/abc/node_modules/dep/index.js"]) {
    sources.set(path, "module.exports = 1");
    expect(modules.read(path).source).toBe("module.exports = 1");
  }
  sources.set("/workspace/repo/packages/ui/node_modules/react/index.js", "module.exports = 1");
  expect(() => modules.read("/workspace/repo/packages/ui/node_modules/react/index.js")).toThrow(/dependency generation/u);
});

it("continues past absent nested package roots before checking a real dependency target", () => {
  const { files, sources } = fixture();
  sources.set("/workspace/node_modules/helper.js", "module.exports = 14");
  files.realpathSync = path => {
    if (!sources.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return path;
  };
  const modules = createGuestModules(files, { generation: 11n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] });
  expect(modules.resolve("helper", "/workspace/.next/server/main.js", "require")).toBe("/workspace/node_modules/helper.js");
});

it("loads live tool-cache modules without admitting another installed package or native addon", () => {
  const { files, sources } = fixture();
  const identity = { generation: 11n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }, { kind: "dependencies", path: "/workspace/app/node_modules" }], runtime: "node", moduleSearchPaths: [] } as const;
  const modules = createGuestModules(files, identity, () => undefined);
  for (const directory of [".cache", ".another-tool", ".vite-temp"]) {
    const path = `/workspace/app/node_modules/${directory}/config.mjs`;
    sources.set(path, "export default 1");
    expect(modules.resolve(`file://${path}`, "/workspace/node_modules/tool/index.js", "import")).toBe(path);
    expect(modules.read(path)).toEqual({ source: "export default 1", format: "module" });
    sources.set(path, "export default 2");
    expect(modules.read(path).source).toBe("export default 2");
  }
  for (const path of ["/outside/node_modules/.cache/file.mjs", "/workspace/other/node_modules/pkg/file.mjs", "/workspace/app/node_modules/.cache/node_modules/pkg/file.mjs", "/workspace/app/node_modules/.file.mjs", "/workspace/app/node_modules/.cache/addon.node"]) {
    sources.set(path, "export default 1");
    expect(() => modules.read(path)).toThrow(/dependency generation/u);
  }
  const cache = "/workspace/app/node_modules/.cache/config.mjs";
  files.realpathSync = path => path === cache ? "/workspace/other/node_modules/package/index.mjs" : path;
  expect(() => modules.read(cache)).toThrow(/dependency generation/u);
});

it("does not treat project cache directories as installed package roots", () => {
  const { files, sources } = fixture(), directory = "/workspace/app/node_modules/.cache";
  sources.set(`${directory}/package.json`, '{"main":"config.mjs"}'); sources.set(`${directory}/config.mjs`, "export default 1");
  const stat = files.statSync.bind(files);
  files.statSync = path => path === directory ? { isFile: () => false, isDirectory: () => true } : stat(path);
  const modules = createGuestModules(files, { generation: 11n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/app/node_modules" }], runtime: "node", moduleSearchPaths: [] });
  expect(() => modules.resolve(".cache", "/workspace/app/main.cjs", "require")).toThrow(/package root/u);
});
