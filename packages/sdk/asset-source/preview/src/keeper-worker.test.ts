import { describe, expect, it } from "vitest";

import { PREVIEW_WORKER_URL, registerPreviewWorker } from "./keeper-worker";

describe("registerPreviewWorker", () => {
  it("registers the session worker under the base, as in builds", async () => {
    const calls: unknown[] = [];
    const registered = await registerPreviewWorker({
      register: (url, options) => {
        calls.push([url, options]);
        return Promise.resolve("registered");
      },
    });
    expect(registered).toBe("registered");
    expect(calls).toEqual([["/__oxidevm/sw.js", { scope: "/" }]]);
    expect(PREVIEW_WORKER_URL).toBe("/__oxidevm/sw.js");
  });
});
