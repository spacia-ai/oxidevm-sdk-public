import { expect, it } from "vitest";
import { isPreviewHost } from "./preview-host.ts";

it("admits only the local keeper and session hosts", () => {
  for (const value of ["preview.localhost", "preview.localhost:5173", `${"a".repeat(32)}.preview.localhost:5173`]) expect(isPreviewHost(value)).toBe(true);
  for (const value of ["localhost:5173", "evil.preview.localhost", "preview.localhost.evil.com", "preview.localhost:999999", "preview.localhost@evil.com"]) expect(isPreviewHost(value)).toBe(false);
});
