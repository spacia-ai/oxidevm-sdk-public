import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import { classifyLicense } from "./license.js";

describe("module license classification", () => {
  it("treats a permissive license as non-copyleft and lists every identifier", () => {
    expect(classifyLicense("Apache-2.0")).toEqual({ ids: ["Apache-2.0"], copyleft: false });
    expect(classifyLicense("MIT OR Apache-2.0").ids).toEqual(["MIT", "Apache-2.0"]);
    expect(classifyLicense("LicenseRef-Proprietary").copyleft).toBe(false);
  });

  it("treats copyleft families as copyleft", () => {
    for (const spdx of ["MPL-2.0", "GPL-3.0-only", "LGPL-2.1-or-later", "AGPL-3.0-only", "EPL-2.0", "CDDL-1.0", "GPL-2.0+"]) {
      expect(classifyLicense(spdx).copyleft, spdx).toBe(true);
    }
  });

  it("lets a licensee pick the permissive branch of OR but not of AND", () => {
    expect(classifyLicense("Apache-2.0 OR MPL-2.0").copyleft).toBe(false);
    expect(classifyLicense("MPL-2.0 OR GPL-2.0-only").copyleft).toBe(true);
    expect(classifyLicense("MIT AND MPL-2.0").copyleft).toBe(true);
    expect(classifyLicense("(MIT OR Apache-2.0) AND BSD-3-Clause").copyleft).toBe(false);
    expect(classifyLicense("MIT OR Apache-2.0 AND MPL-2.0").copyleft).toBe(false);
  });

  it("keeps the copyleft class of the base license when an exception applies", () => {
    expect(classifyLicense("GPL-2.0-only WITH Classpath-exception-2.0")).toEqual({ ids: ["GPL-2.0-only"], copyleft: true });
  });

  it("rejects malformed expressions and placeholders with a typed error", () => {
    for (const spdx of ["", "NOASSERTION", "NONE", "MIT OR", "OR MIT", "(MIT", "MIT)", "MIT WITH", "MIT AND AND ISC", "bad token!", "MIT ISC"]) {
      expect(() => classifyLicense(spdx), JSON.stringify(spdx)).toThrow(VMError);
    }
    try { classifyLicense("NOASSERTION"); } catch (error: unknown) {
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    }
  });
});
