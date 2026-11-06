import { expect, it } from "vitest";
import { sdkVersion } from "../sdk-version.js";
import { DEFAULT_FRAME_ORIGIN, runtimeFrameEngineUrl, runtimeFrameUrl } from "./location.js";

it("places this release's frame under /v/<sdkVersion>/ and its engine under /engine/<release-id>/ of the frame origin", () => {
  const frame = runtimeFrameUrl(DEFAULT_FRAME_ORIGIN), id = "0".repeat(64);
  expect(frame).toBe(`https://run.oxidevm.dev/v/${encodeURIComponent(sdkVersion)}/`);
  expect(runtimeFrameEngineUrl(frame, id)).toBe(`https://run.oxidevm.dev/engine/${id}/`);
  expect(runtimeFrameEngineUrl(runtimeFrameUrl("http://run.localhost:4179"), id)).toBe(`http://run.localhost:4179/engine/${id}/`);
});
