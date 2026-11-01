import { describe, expect, it } from "vitest";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { launch, records } from "./harness.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commandRelease = (adapter: string): Promise<Release> => buildRelease({ adapter, artifacts: { "tool.wasm": wasm }, declaration: COMMAND_DECLARATION });

describe("pinned files that cannot be fetched", () => {
  it("reports a file the start cannot fetch as a launch failure with reason wasm-module-artifact, not an adapter fault", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });");
    const gone: Release = { ...release, served: new Map([...release.served].filter(([url]) => !url.endsWith("tool.wasm"))) };
    const running = launch({ release: gone });
    await expect(running.done).resolves.toBe(120);
    expect(records(running.linux.stderrLines)).toEqual([{ oxidevm: "error", v: 1, kind: "launch", message: "Artifact tool.wasm is unavailable (HTTP 404)", reason: "wasm-module-artifact" }]);
    expect(running.imports.count).toBe(0);
  });

  it("classifies a fetch the adapter's own use of a file makes the same way", async () => {
    const release = await commandRelease(`export default async host => { await host.artifacts.bytes("tool.wasm"); return { main: () => 0 }; };`);
    let requests = 0;
    const running = launch({ release, fetch: url => {
      // The check before the adapter runs succeeds; the adapter's own load of the file meets a network failure.
      if (url.endsWith("tool.wasm") && ++requests > 1) return Promise.reject(new TypeError("Failed to fetch"));
      const bytes = release.served.get(url);
      return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
    } });
    await expect(running.done).resolves.toBe(120);
    expect(records(running.linux.stderrLines).at(-1)).toEqual({ oxidevm: "error", v: 1, kind: "launch", message: "Artifact tool.wasm could not be fetched", reason: "wasm-module-artifact" });
    expect(running.imports.count).toBe(1);
  });
});
