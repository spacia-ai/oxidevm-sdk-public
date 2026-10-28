import { expect, it, vi } from "vitest";
import { createGuestModules } from "./guest-modules.js";

it("combines canonical metadata and caches only the admitted immutable generation", () => {
  const sources = new Map([
    ["/workspace/node_modules/a.js", "module.exports = 1"],
    ["/workspace/node_modules/package.json", '{"type":"commonjs"}'],
    ["/workspace/app.js", "module.exports = 2"],
    ["/workspace/package.json", '{"type":"module"}'],
  ]);
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const files = {
    readFileSync: vi.fn((path: string) => sources.get(path) ?? (() => { throw missing(); })()),
    statSync: vi.fn(() => { throw new Error("Separate stat crossing"); }),
    realpathSync: vi.fn(() => { throw new Error("Separate realpath crossing"); }),
  };
  const inspect = vi.fn((path: string) => {
    if (!sources.has(path)) throw missing();
    return { path, mode: 0o100644 };
  });
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] } as const;
  const modules = createGuestModules(files, identity, undefined, inspect);
  expect(modules.resolve("./a.js", "/workspace/node_modules/main.cjs", "require")).toBe("/workspace/node_modules/a.js");
  modules.read("/workspace/node_modules/a.js");
  const inspections = inspect.mock.calls.length;
  const reads = files.readFileSync.mock.calls.filter(([path]) => path.endsWith("package.json")).length;
  modules.resolve("./a.js", "/workspace/node_modules/main.cjs", "require");
  modules.read("/workspace/node_modules/a.js");
  expect(inspect.mock.calls.length).toBe(inspections);
  expect(files.readFileSync.mock.calls.filter(([path]) => path.endsWith("package.json"))).toHaveLength(reads);
  expect(modules.read("/workspace/app.js").format).toBe("module");
  sources.set("/workspace/package.json", '{"type":"commonjs"}');
  expect(modules.read("/workspace/app.js").format).toBe("commonjs");
  const next = createGuestModules(files, { ...identity, generation: 2n }, undefined, inspect);
  next.resolve("./a.js", "/workspace/node_modules/main.cjs", "require");
  expect(inspect.mock.calls.length).toBeGreaterThan(inspections);
});

it("validates symlink targets and preserves permission errors before caching metadata", () => {
  const files = {
    readFileSync: () => "module.exports = 1",
    statSync: () => undefined, realpathSync: (path: string) => path,
  };
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] } as const;
  const inspect = vi.fn(() => ({ path: "/workspace/private.js", mode: 0o100644 }));
  const modules = createGuestModules(files, identity, undefined, inspect);
  // A frozen link to editable source is followed, but its metadata is never cached.
  expect(modules.resolve("./link.js", "/workspace/node_modules/entry.cjs", "require")).toBe("/workspace/private.js");
  expect(modules.resolve("./link.js", "/workspace/node_modules/entry.cjs", "require")).toBe("/workspace/private.js");
  expect(inspect).toHaveBeenCalledTimes(2);
  inspect.mockImplementation(() => ({ path: "/workspace/other/node_modules/a.js", mode: 0o100644 }));
  expect(() => modules.resolve("./other.js", "/workspace/node_modules/entry.cjs", "require")).toThrow(/dependency generation/u);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  inspect.mockImplementation(() => { throw denied; });
  expect(() => modules.resolve("./link.js", "/workspace/node_modules/entry.cjs", "require")).toThrow(denied);
  inspect.mockImplementation(() => ({ path: "/workspace/node_modules/a.js", mode: 0o100644 }));
  expect(modules.resolve("./link.js", "/workspace/node_modules/entry.cjs", "require")).toBe("/workspace/node_modules/a.js");
});
