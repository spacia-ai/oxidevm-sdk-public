import { expect, it, vi } from "vitest";
import { defaultImage } from "./default-image.js";

vi.mock("./defaults.generated.js", () => ({ defaultImageLocations: {} }));

it("requires an explicit image when the release has no managed defaults", () => {
  for (const mode of ["system", "userspace"] as const) {
    let failure: unknown;
    try { defaultImage(mode); } catch (error: unknown) { failure = error; }
    expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  }
});
