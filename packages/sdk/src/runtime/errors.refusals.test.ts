import { afterEach, expect, it } from "vitest";
import { lateFailureOf } from "./js-process/late-failure.js";
import { observeRefusals, VMError } from "./errors.js";

afterEach(() => { observeRefusals(undefined); });

it("tells the process worker about every typed refusal it makes, also one the program then catches", () => {
  const seen: unknown[] = [];
  observeRefusals(error => { seen.push(lateFailureOf(error)); });
  try {
    throw new VMError("FEATURE_NOT_AVAILABLE", "builtin export is not supported", { lateFailure: "unavailable-builtin", subject: "node:vm.SourceTextModule" });
  } catch { /* The program answers with its own startup error, as Vitest does. */ }
  new VMError("PROTOCOL_ERROR", "not a refusal");
  new VMError("FEATURE_NOT_AVAILABLE", "no late failure detail", { api: "x" });
  expect(seen).toEqual([{ kind: "unavailable-builtin", detail: "node:vm.SourceTextModule" }]);
  observeRefusals(undefined);
  new VMError("FEATURE_NOT_AVAILABLE", "unobserved", { lateFailure: "unavailable-builtin", subject: "node:x.y" });
  expect(seen).toHaveLength(1);
});
