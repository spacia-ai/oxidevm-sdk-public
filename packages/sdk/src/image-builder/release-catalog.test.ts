import { expect, it } from "vitest";
import { decodeReleaseCatalog, readReleaseCatalog } from "./release-catalog.js";
import { defaultImageLocations } from "../defaults.generated.js";
import { getSDKRelease } from "./project.js";

it("binds both separately distributed modes and rejects missing integration, credentials and unknown fields", () => {
  const artifact = { url: "https://example.com/actual.tar.gz", bytes: 12, sha256: "a".repeat(64) };
  const value = { schemaVersion: 2, sdkVersion: "1", images: [{ mode: "system", manifestSHA256: "b".repeat(64), archive: artifact }, { mode: "userspace", manifestSHA256: "c".repeat(64), archive: artifact }], bootstrap: { identity: "d".repeat(64), archive: artifact, files: ["kernel", "agent", "init"].map(name => ({ name, bytes: 1, sha256: "a".repeat(64) })) } };
  expect(decodeReleaseCatalog(value).images).toHaveLength(2);
  expect(() => decodeReleaseCatalog({ ...value, extra: true })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, images: [value.images[0], value.images[0]] })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, bootstrap: { ...value.bootstrap, files: [] } })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, bootstrap: { ...value.bootstrap, archive: { ...artifact, url: "https://name:secret@example.com/file" } } })).toThrow();
});

it("accepts an explicit-image catalog without managed images or kernel integration", () => {
  const value = { schemaVersion: 3, sdkVersion: "0.0.1", images: [], bootstrap: null };
  expect(decodeReleaseCatalog(value)).toEqual(value);
  expect(() => decodeReleaseCatalog({ ...value, extra: true })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, images: "none" })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, bootstrap: {} })).toThrow();
  expect(() => decodeReleaseCatalog({ ...value, schemaVersion: 2 })).toThrow();
});

// `oxidevm assets install` downloads a missing default image from this catalog; a catalog that
// lags the pinned defaults leaves a clean machine unable to install them.
it("lists exactly the default images this SDK version pins", async () => {
  const catalog = await readReleaseCatalog();
  expect(catalog.sdkVersion).toBe(getSDKRelease().sdkVersion);
  for (const location of Object.values(defaultImageLocations)) {
    expect(catalog.images).toContainEqual(expect.objectContaining({ mode: location.mode, manifestSHA256: location.manifestSHA256 }));
  }
});
