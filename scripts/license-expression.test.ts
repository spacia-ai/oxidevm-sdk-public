import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedLicense } from "./license-expression.ts";

await test("license election records a permitted OR branch and preserves all AND obligations", () => {
  const allowed = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "Apache-2.0 WITH LLVM-exception"]);
  assert.equal(selectedLicense("GPL-2.0-only OR MIT", allowed), "MIT");
  assert.equal(selectedLicense("(MPL-2.0 OR Apache-2.0) AND BSD-3-Clause", allowed), "(Apache-2.0 AND BSD-3-Clause)");
  assert.equal(selectedLicense("MIT AND GPL-2.0-only", allowed), undefined);
  assert.equal(selectedLicense("Apache-2.0 WITH LLVM-exception", allowed), "Apache-2.0 WITH LLVM-exception");
  for (const value of ["MIT OR", "MIT WITH unknown", "MIT; GPL-2.0-only", "NOASSERTION"]) assert.equal(selectedLicense(value, allowed), undefined);
});
