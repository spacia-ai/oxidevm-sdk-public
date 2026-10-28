import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sdkVersion } from "./sdk-version.js";

describe("SDK version module", () => {
  it("names the version in the package manifest, which the release script sets in both", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest).toMatchObject({ version: sdkVersion });
  });
});
