import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import type { TrialFailure } from "../../js-process/late-failure.js";
import { probeAddon } from "./trial-load.js";

function probe(load: (path: string) => unknown): { code: number; reports: TrialFailure[]; paths: string[] } {
  const reports: TrialFailure[] = [], paths: string[] = [];
  const code = probeAddon(path => { paths.push(path); return load(path); }, "/workspace/app/node_modules/pkg/pkg.node", failure => { reports.push(failure); });
  return { code, reports, paths };
}

it("opens the one add-on and passes when its initializer returns", () => {
  expect(probe(() => ({ answer: 42 }))).toEqual({ code: 0, reports: [], paths: ["/workspace/app/node_modules/pkg/pkg.node"] });
});

it("reports the limitation an error names, else the class of what the initializer threw", () => {
  expect(probe(() => { throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported Node-API operation: napi_x", { lateFailure: "unsupported-node-api", subject: "napi_x" }); }))
    .toMatchObject({ code: 1, reports: [{ kind: "unsupported-node-api", detail: "napi_x" }] });
  expect(probe(() => { throw new TypeError("secret value /home/user"); })).toMatchObject({ code: 1, reports: [{ kind: "addon-init-threw", detail: "TypeError" }] });
  expect(probe(() => { throw Object.assign(new Error("x"), { name: "" }); })).toMatchObject({ reports: [{ detail: "Error" }] });
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- an initializer may throw anything
  expect(probe(() => { throw "text"; })).toMatchObject({ code: 1, reports: [{ kind: "addon-init-threw", detail: "string" }] });
});
