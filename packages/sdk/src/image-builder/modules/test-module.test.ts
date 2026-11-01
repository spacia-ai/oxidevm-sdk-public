import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineImage } from "../../image.js";
import { buildReleaseFiles, writeReleaseDirectory } from "./release.test-support.js";
import { testModule } from "./test-module.js";

const trust = { algorithm: "Ed25519", keyId: "ed25519-00000000000000000000000000000000", publicKey: "MCowBQYDK2VwAyEAeedEVqOwHsoVeXNDCFsjOQ9tYw5Kx70O5Zkgr5JdThA=" } as const;
const image = defineImage({ mode: "userspace", manifestUrl: "https://cdn.oxidevm.dev/images/x/1/manifest.json", manifestSHA256: "0".repeat(64), trust });

describe("testModule input checks", () => {
  let directory = "";
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "oxidevm-wasm-test-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("refuses a dist whose files differ from SHA256SUMS before resolving any engine or browser", async () => {
    await writeReleaseDirectory(directory, buildReleaseFiles());
    await writeFile(join(directory, "adapter.mjs"), "export default () => ({ main: () => 1 });");
    // An engine directory that does not exist proves the order: the release check fails first.
    await expect(testModule(directory, { image, browser: "chromium", engineDir: join(directory, "no-engine") })).rejects.toThrow("adapter.mjs");
  });

  it("refuses a directory that is not a built release", async () => {
    await expect(testModule(directory, { image, browser: "chromium" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
