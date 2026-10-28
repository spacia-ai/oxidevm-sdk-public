import { posix, win32 } from "node:path";
import { expect, it } from "vitest";
import { createNodePath } from "./node-path.ts";

const paths = ["", ".", "..", "...", ".hidden", "/", "//", "///", "//foo", "///foo", "foo/", "foo//bar", "a/../", "../../a", "/a/../../b/", "a.b/c.d", "a//b//", "\0"];
it("matches POSIX path values and preserves the process cwd", () => {
  const path = createNodePath(() => "/workspace/app");
  expect(path.posix).toBe(path);
  expect(path.win32.sep).toBe(win32.sep);
  expect(path.win32.delimiter).toBe(win32.delimiter);
  for (const value of paths) {
    expect(path.normalize(value), `normalize ${JSON.stringify(value)}`).toBe(posix.normalize(value));
    expect(path.dirname(value), `dirname ${JSON.stringify(value)}`).toBe(posix.dirname(value));
    expect(path.basename(value)).toBe(posix.basename(value));
    expect(path.extname(value)).toBe(posix.extname(value));
    expect(path.parse(value), `parse ${JSON.stringify(value)}`).toEqual(posix.parse(value));
    expect(path.resolve(value)).toBe(posix.resolve("/workspace/app", value));
    for (const other of paths) {
      expect(path.join(value, other)).toBe(posix.join(value, other));
      expect(path.relative(value, other)).toBe(posix.relative(posix.resolve("/workspace/app", value), posix.resolve("/workspace/app", other)));
      expect(path.basename(value, other)).toBe(posix.basename(value, other));
    }
  }
  for (const value of [{}, { name: "file", ext: "txt" }, { root: "/", name: "file", ext: ".txt" }, { dir: "/a", base: "b" }]) {
    expect(path.format(value)).toBe(posix.format(value));
  }
  expect(() => path.join("a", 1)).toThrow(TypeError);
  expect(() => path.normalize(null)).toThrow(TypeError);
});
