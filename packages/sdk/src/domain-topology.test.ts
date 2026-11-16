import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME_ORIGIN } from "./frame/location.js";
import { decodePublicVMOptions, DEFAULT_FRAME_PREVIEW_ORIGIN } from "./vm-options.js";
import { VMError } from "./runtime/errors.js";

describe("OxVM trusted and preview domain separation", () => {
  it("uses the trusted runtime and the separate preview domain", () => {
    expect(DEFAULT_FRAME_ORIGIN).toBe("https://run.oxvm.dev");
    expect(DEFAULT_FRAME_PREVIEW_ORIGIN).toBe("https://tabvm.dev");
    for (const mode of ["system", "userspace"] as const) {
      const options = decodePublicVMOptions({ mode, runtime: { hosting: "frame" } });
      expect(options.runtime).toMatchObject({ origin: "https://run.oxvm.dev" });
      expect(options.preview).toEqual({ origin: "https://tabvm.dev", isolation: "per-session" });
    }
  });

  it.each(["https://oxvm.dev", "https://preview.oxvm.dev", "https://oxvm.dev:8443", "https://oxvm.dev.", "https://preview.oxvm.dev."])("refuses official previews under the trusted site: %s", origin => {
    for (const mode of ["system", "userspace"] as const) {
      for (const runtimeOrigin of ["https://run.oxvm.dev", "https://run.oxidevm.dev"]) {
        expect(() => decodePublicVMOptions({ mode, runtime: { hosting: "frame", origin: runtimeOrigin }, preview: { origin, isolation: "per-session" } })).toThrow(VMError);
      }
    }
  });
});
