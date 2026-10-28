import { describe, expect, it, vi } from "vitest";
import { defaultImage, VMError } from "./index.js";
import { legacyImageLocations as defaultImageLocations } from "./default-images.test-support.js";

vi.mock("./defaults.generated.js", async () => ({ defaultImageLocations: (await import("./default-images.test-support.js")).legacyImageLocations }));

describe("legacy release image defaults", () => {
  it("names each mode's pinned digest and author key at its default address", () => {
    for (const mode of ["userspace", "system"] as const) {
      const image = defaultImage(mode);
      expect(image.mode).toBe(mode);
      expect(image.manifestUrl).toBe(defaultImageLocations[mode].manifestUrl);
      expect(image.manifestSHA256).toBe(defaultImageLocations[mode].manifestSHA256);
      expect(image.trust).toEqual(defaultImageLocations[mode].trust);
    }
  });
  it("keeps the digest and key when the same image is served from another address", () => {
    const image = defaultImage("userspace", "https://images.example/sdk-alpine-smoke/manifest.json");
    expect(image.manifestUrl).toBe("https://images.example/sdk-alpine-smoke/manifest.json");
    expect(image.manifestSHA256).toBe(defaultImageLocations["userspace"].manifestSHA256);
    expect(image.trust).toEqual(defaultImageLocations["userspace"].trust);
  });
  it("refuses an untrustworthy address", () => {
    expect(() => defaultImage("userspace", "http://images.example/manifest.json")).toThrow(VMError);
  });
});
