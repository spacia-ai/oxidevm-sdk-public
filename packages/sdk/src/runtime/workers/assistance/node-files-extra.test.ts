import { describe, expect, it } from "vitest";
import { nativeRealpath, withNativeRealpath } from "./node-files-extra.js";

describe("fs realpath native aliases", () => {
  it("gives realpathSync and realpath a native member that is the same implementation", () => {
    const sync = (path: unknown): string => `sync:${String(path)}`;
    const async = (...args: unknown[]): void => { const [path, callback] = args; if (typeof callback === "function") Reflect.apply(callback, undefined, [null, `async:${typeof path === "string" ? path : ""}`]); };
    const fs = withNativeRealpath({ realpathSync: sync, realpath: async });
    expect(fs.realpathSync("/a")).toBe("sync:/a");
    expect(nativeRealpath(fs.realpathSync)("/a")).toBe("sync:/a");
    expect(Reflect.get(fs.realpathSync, "native")).toBe(fs.realpathSync);
    expect(Reflect.get(fs.realpath, "native")).toBe(fs.realpath);
  });
});
