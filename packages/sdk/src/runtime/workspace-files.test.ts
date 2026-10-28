import { describe, expect, it } from "vitest";
import { BrowserWorkspace } from "./workspace.js";
import { VMError } from "./errors.js";

describe("native workspace API", () => {
  it("fails explicitly when the image has no native file capability", async () => {
    const workspace = new BrowserWorkspace("test", {
      readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve(),
      list: () => Promise.resolve([]), remove: () => Promise.resolve(),
    });
    await expect(workspace.stat("/app.ts")).rejects.toMatchObject({
      code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" },
    });
  });

  it("validates bounded writes and version conditions before dispatch", () => {
    const workspace = new BrowserWorkspace("test", {
      readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve(),
      list: () => Promise.resolve([]), remove: () => Promise.resolve(),
    });
    expect(() => workspace.write("/app.ts", new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(VMError);
    expect(() => workspace.write("/app.ts", new Uint8Array(), { ifVersion: "bad" })).toThrow(VMError);
  });
});
