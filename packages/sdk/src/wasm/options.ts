import { VMError } from "../runtime/errors.js";
import type { OptionDecl } from "./manifest-types.js";

/** Stable `detail.reason` for an option a consumer passed that the manifest does not accept. */
export const OPTIONS_INVALID = "wasm-module-options";

export type OptionScalar = string | number | boolean | readonly string[];
export type ResolvedOptionValues = Readonly<Record<string, OptionScalar>>;

function reject(label: string, message: string): never {
  throw new VMError("INVALID_ARGUMENT", `${label}: ${message}`, { reason: OPTIONS_INVALID });
}

function resolveOne(decl: OptionDecl, value: unknown, label: string): OptionScalar {
  switch (decl.type) {
    case "boolean":
      return typeof value === "boolean" ? value : reject(label, "must be a boolean");
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < decl.min || value > decl.max) return reject(label, `must be an integer from ${String(decl.min)} to ${String(decl.max)}`);
      return value;
    case "string":
      if (typeof value !== "string" || value.length > decl.maxLength || value.includes("\0")) return reject(label, `must be a string of at most ${String(decl.maxLength)} characters without NUL`);
      return value;
    case "enum": {
      const found = decl.values.find(allowed => allowed === value);
      return found ?? reject(label, `must be one of ${decl.values.join(", ")}`);
    }
    case "enum-set": {
      if (!Array.isArray(value)) return reject(label, "must be an array");
      const members = Array.from<unknown>(value).map(item => decl.values.find(allowed => allowed === item) ?? reject(label, `may contain only ${decl.values.join(", ")}`));
      if (new Set(members).size !== members.length) return reject(label, "contains duplicates");
      return members;
    }
  }
}

/**
 * Applies the manifest's option declarations to what a consumer passed: unknown names and wrong
 * values are rejected, defaults fill the gaps, and an option without a default must be present.
 * Both `spawnModule` and the runner call it, so a bad value fails early and cannot slip through.
 */
export function resolveOptions(decls: Readonly<Record<string, OptionDecl>> | undefined, input: unknown, label = "options"): ResolvedOptionValues {
  const declared = decls ?? {};
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) reject(label, "must be an object");
  const supplied: Readonly<Record<string, unknown>> = input === undefined ? {} : Object.fromEntries(Object.entries(input));
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(declared, name)) reject(label, `${name} is not an option of this module`);
  const resolved: Record<string, OptionScalar> = {};
  for (const [name, decl] of Object.entries(declared)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : decl.default;
    if (value === undefined) reject(label, `${name} is required`);
    resolved[name] = resolveOne(decl, value, `${label}.${name}`);
  }
  return resolved;
}
