import { describe, expect, it } from "vitest";
import { createNodeStreamWeb, NODE_STREAM_WEB_EXPORTS } from "./node-stream-web.js";

describe("node stream/web builtin", () => {
  it("exposes the platform's Web Streams classes under Node's export names", () => {
    const module = createNodeStreamWeb(globalThis);
    for (const name of NODE_STREAM_WEB_EXPORTS) {
      expect(module[name], name).toBe(Reflect.get(globalThis, name));
      expect(typeof module[name], name).toBe("function");
    }
    expect(Object.keys(module).sort()).toEqual([...NODE_STREAM_WEB_EXPORTS].sort());
  });

  it("refuses a platform that lacks one of the classes instead of exporting undefined", () => {
    const partial = Object.fromEntries(NODE_STREAM_WEB_EXPORTS.filter(name => name !== "TransformStream")
      .map(name => [name, Reflect.get(globalThis, name)]));
    expect(() => createNodeStreamWeb(partial)).toThrow(/TransformStream/u);
  });
});
