import { expect, it } from "vitest";
import type { OptionDecl } from "./manifest-types.js";
import { resolveOptions } from "./options.js";

const decls: Readonly<Record<string, OptionDecl>> = {
  durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
  dataDir: { type: "string", maxLength: 16 },
  workers: { type: "integer", min: 1, max: 4, default: 2 },
  verbose: { type: "boolean" },
  packages: { type: "enum-set", values: ["pandas", "matplotlib"], default: ["pandas"] },
};
const required = { dataDir: "/data", verbose: false };

it("fills defaults, keeps supplied values and returns every declared option", () => {
  expect(resolveOptions(decls, required)).toEqual({ durability: "strict", dataDir: "/data", workers: 2, verbose: false, packages: ["pandas"] });
  expect(resolveOptions(decls, { ...required, durability: "relaxed", workers: 4, packages: ["matplotlib", "pandas"] })).toMatchObject({ durability: "relaxed", workers: 4, packages: ["matplotlib", "pandas"] });
  expect(resolveOptions(undefined, undefined)).toEqual({});
  expect(resolveOptions({}, {})).toEqual({});
});

it("rejects a missing required option, an unknown name and a non-object", () => {
  expect(() => resolveOptions(decls, {})).toThrow(/dataDir is required/u);
  expect(() => resolveOptions(decls, { dataDir: "/d" })).toThrow(/verbose is required/u);
  expect(() => resolveOptions(decls, { ...required, extra: 1 })).toThrow(/extra is not an option/u);
  expect(() => resolveOptions(undefined, { anything: 1 })).toThrow(/anything is not an option/u);
  for (const input of [null, [], "x", 3]) expect(() => resolveOptions(decls, input)).toThrow(/must be an object/u);
});

function thrown(action: () => unknown): unknown {
  try { action(); } catch (error: unknown) { return error; }
  return undefined;
}

it("rejects wrong values for every option type with a stable reason", () => {
  const bad: readonly (readonly [string, unknown])[] = [
    ["durability", "paranoid"], ["durability", 1], ["dataDir", "x".repeat(17)], ["dataDir", "a\0b"], ["dataDir", 5],
    ["workers", 0], ["workers", 5], ["workers", 1.5], ["workers", "2"], ["verbose", "yes"],
    ["packages", "pandas"], ["packages", ["numpy"]], ["packages", ["pandas", "pandas"]], ["packages", [1]],
  ];
  for (const [name, value] of bad) {
    expect(thrown(() => resolveOptions(decls, { ...required, [name]: value })), `${name}=${JSON.stringify(value)}`).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-options" } });
  }
});

it("treats an inherited property as absent", () => {
  // A `__proto__` entry in an object literal sets the prototype, so `dataDir` is inherited, not own.
  const inherited: Record<string, unknown> = { __proto__: { dataDir: "/hijacked" }, verbose: true };
  expect(Object.keys(inherited)).toEqual(["verbose"]);
  expect(() => resolveOptions(decls, inherited)).toThrow(/dataDir is required/u);
});

it("never reads an option from Object.prototype, even when it is named like one of its members", () => {
  // Written as entries: in an object literal TypeScript types a property called `constructor` after Object.prototype.
  const named: Readonly<Record<string, OptionDecl>> = Object.fromEntries<OptionDecl>([
    ["constructor", { type: "string", maxLength: 8, default: "own" }],
    ["toString", { type: "boolean", default: true }],
  ]);
  expect(resolveOptions(named, undefined)).toEqual({ constructor: "own", toString: true });
  expect(resolveOptions(named, { constructor: "set", toString: false })).toEqual({ constructor: "set", toString: false });
});
