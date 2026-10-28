import { describe, expect, it } from "vitest";

import { readBrowserQuota } from "./browser-quota.js";

describe("browser quota", () => {
  it("reports the origin's estimate in whole bytes and whether its storage is persistent", async () => {
    const manager = { estimate: () => Promise.resolve({ usage: 1500.7, quota: 9600 }), persisted: () => Promise.resolve(true) };

    await expect(readBrowserQuota(manager)).resolves.toEqual({ estimate: { usage: 1500, quota: 9600 }, persisted: true });
  });

  it("reports nothing it cannot read instead of failing", async () => {
    const refused = { estimate: () => Promise.reject(new Error("blocked")), persisted: () => Promise.reject(new Error("blocked")) };
    const partial = { estimate: () => Promise.resolve({ usage: 10 }), persisted: () => Promise.resolve(false) };

    await expect(readBrowserQuota(undefined)).resolves.toEqual({ estimate: null, persisted: null });
    await expect(readBrowserQuota(refused)).resolves.toEqual({ estimate: null, persisted: null });
    await expect(readBrowserQuota(partial)).resolves.toEqual({ estimate: null, persisted: false });
  });
});
