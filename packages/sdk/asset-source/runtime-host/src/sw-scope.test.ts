import { expect, it } from "vitest";
import { handledByShell } from "./sw-scope.ts";

const scope = new URL("https://run.oxidevm.dev/v/0.0.10/");

it("serves the runtime frame's own files and leaves the module frame directory to the network (ADR 0028)", () => {
  expect(handledByShell(new URL("https://run.oxidevm.dev/v/0.0.10/"), "GET", scope)).toBe(true);
  expect(handledByShell(new URL("https://run.oxidevm.dev/v/0.0.10/assets/index-abc.js"), "GET", scope)).toBe(true);
  // The module frame needs its own response headers (sandbox CSP, CORP cross-origin), which only the server sends.
  for (const path of ["module-frame/", "module-frame/index.html", "module-frame/broker.js", "module-frame/runner.js"]) {
    expect(handledByShell(new URL(path, scope), "GET", scope), path).toBe(false);
  }
  expect(handledByShell(new URL("https://run.oxidevm.dev/engine/x/release.json"), "GET", scope)).toBe(false);
  expect(handledByShell(new URL("https://other.test/v/0.0.10/"), "GET", scope)).toBe(false);
  expect(handledByShell(new URL("https://run.oxidevm.dev/v/0.0.10/"), "POST", scope)).toBe(false);
});
