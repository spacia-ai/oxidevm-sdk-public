import { describe, expect, it } from "vitest";
import { createGuestModules } from "./guest-modules.js";

/** `require(".")` and `require("..")` name the requiring file's own directory and its parent, as in Node's CommonJS
 * resolver; npm's `@sigstore/tuf` loads its index that way. ESM has no such form. */
function fixture() {
  const sources = new Map([
    ["/workspace/node_modules/pkg/package.json", '{"name":"pkg","main":"dist/index.js"}'],
    ["/workspace/node_modules/pkg/dist/index.js", "module.exports = 1;"],
    ["/workspace/node_modules/pkg/dist/client.js", "module.exports = require('.');"],
    ["/workspace/node_modules/pkg/dist/sub/deep.js", "module.exports = require('..');"],
  ]);
  const directories = new Set(["/workspace", "/workspace/node_modules", "/workspace/node_modules/pkg", "/workspace/node_modules/pkg/dist", "/workspace/node_modules/pkg/dist/sub"]);
  const files = {
    readFileSync(path: string): string {
      const value = sources.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: directories.has(path) ? "EISDIR" : "ENOENT" });
      return value;
    },
    statSync(path: string) {
      if (!sources.has(path) && !directories.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => sources.has(path), isDirectory: () => directories.has(path) };
    },
    realpathSync(path: string): string { return path; },
  };
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], runtime: "node", moduleSearchPaths: [] } as const;
  return createGuestModules(files, identity);
}
function thrown(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected a failure");
}

describe("the dot specifiers of CommonJS", () => {
  it("resolves require('.') to the requiring file's directory and require('..') to its parent", () => {
    const modules = fixture();
    expect(modules.resolve(".", "/workspace/node_modules/pkg/dist/client.js", "require")).toBe("/workspace/node_modules/pkg/dist/index.js");
    expect(modules.resolve("..", "/workspace/node_modules/pkg/dist/sub/deep.js", "require")).toBe("/workspace/node_modules/pkg/dist/index.js");
  });

  it("keeps refusing them as ES module specifiers, as Node does", () => {
    const modules = fixture();
    for (const specifier of [".", ".."]) {
      expect(thrown(() => modules.resolve(specifier, "/workspace/node_modules/pkg/dist/client.js", "import"))).toMatchObject({ code: "ERR_INVALID_MODULE_SPECIFIER" });
    }
  });
});
