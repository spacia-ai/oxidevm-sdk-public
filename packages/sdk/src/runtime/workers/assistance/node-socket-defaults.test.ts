import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { createSocketDefaults } from "./node-socket-defaults.js";

const inputs = new Map<string, unknown>([
  ["true", true], ["false", false], ["undefined", undefined], ["null", null], ["number", 1], ["string", "true"], ["object", {}],
  ["one", 1], ["nine", 9], ["ten", 10], ["normal", 2500], ["max", 2147483647], ["zero", 0], ["negative", -1],
  ["overflow", 2147483648], ["fraction", 1.5], ["nan", NaN], ["infinity", Infinity], ["boolean", true], ["bigint", 1n],
]);
it.each(["node", "bun"] as const)("matches pinned %s defaults, returns, validation and unchanged state on errors", runtime => {
  const control = record(JSON.parse(readFileSync(new URL("./node-socket-defaults.controls.json", import.meta.url), "utf8")), "net defaults controls");
  const source = record(control[runtime], "runtime defaults"), defaults = createSocketDefaults({ runtime });
  expect(source["binarySHA256"]).toMatch(/^[0-9a-f]{64}$/u);
  const snapshot = () => ({ auto: defaults.getDefaultAutoSelectFamily(), timeout: defaults.getDefaultAutoSelectFamilyAttemptTimeout() });
  expect(snapshot()).toEqual(source["initial"]);
  const rows = source["rows"];
  if (!Array.isArray(rows) || rows.length !== 23) throw new Error("Incomplete net defaults controls");
  for (const value of rows) {
    const row = record(value, "net default case"), method = row["method"], label = row["label"];
    if (typeof label !== "string" || !inputs.has(label)) throw new Error("Unknown net default input");
    const before = record(row["before"], "previous defaults");
    defaults.setDefaultAutoSelectFamily(before["auto"]); defaults.setDefaultAutoSelectFamilyAttemptTimeout(before["timeout"]);
    const previous = snapshot();
    const input = label === "string" && method === "setDefaultAutoSelectFamilyAttemptTimeout" ? "250" : inputs.get(label);
    let actual: object;
    try {
      const returned = method === "setDefaultAutoSelectFamily" ? defaults.setDefaultAutoSelectFamily(input)
        : method === "setDefaultAutoSelectFamilyAttemptTimeout" ? defaults.setDefaultAutoSelectFamilyAttemptTimeout(input) : (() => { throw new Error("Unknown method"); })();
      actual = { returned: returned ?? null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code: unknown = Reflect.get(error, "code");
      actual = { error: { name: error.name, code: code ?? null, message: error.message } };
    }
    expect({ method, label, before: previous, ...actual, after: snapshot() }).toEqual(row);
  }
});

it("shares Bun's selection flag across workers and keeps each attempt timeout local", () => {
  const shared = new Int32Array(new SharedArrayBuffer(4)); shared[0] = 1;
  const parent = createSocketDefaults({ runtime: "bun", autoSelectFamily: shared }), worker = createSocketDefaults({ runtime: "bun", autoSelectFamily: shared });
  parent.setDefaultAutoSelectFamily(false); parent.setDefaultAutoSelectFamilyAttemptTimeout(1234);
  expect(worker.getDefaultAutoSelectFamily()).toBe(false); expect(worker.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(250);
  worker.setDefaultAutoSelectFamily(true); worker.setDefaultAutoSelectFamilyAttemptTimeout(5432);
  expect(parent.getDefaultAutoSelectFamily()).toBe(true); expect(parent.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1234);
  expect(createSocketDefaults().getDefaultAutoSelectFamily()).toBe(true);
  expect(() => createSocketDefaults({ runtime: "node", autoSelectFamily: shared })).toThrow();
});
