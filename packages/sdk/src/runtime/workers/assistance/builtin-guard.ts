import { lateFailureDetail, type LateFailure } from "../../js-process/late-failure.ts";

/**
 * ADR 0026: the real exports a provided built-in lacks (the pinned runtime's own list). Each
 * reads as undefined, as an absent export did, and stays out of enumeration, so copies, spreads
 * and ESM wrappers never touch it; assigning it makes it an ordinary property. The first one a
 * process reads is kept: a process that then fails is reported by that exact name, and the
 * program runs in full Linux next time.
 */
export function guardMissingExports(builtins: Readonly<Record<string, unknown>>, real: Readonly<Record<string, readonly string[]>>): () => LateFailure | undefined {
  let touched: LateFailure | undefined;
  for (const [name, module] of Object.entries(builtins)) {
    const expected = real[name];
    if (expected === undefined || (typeof module !== "object" && typeof module !== "function") || module === null || !Object.isExtensible(module)) continue;
    for (const key of expected) {
      if (key in module) continue;
      Object.defineProperty(module, key, {
        configurable: true,
        enumerable: false,
        get(): undefined {
          touched ??= { kind: "unavailable-builtin", detail: lateFailureDetail(`node:${name}.${key}`) };
          return undefined;
        },
        set(value: unknown) { Object.defineProperty(module, key, { configurable: true, enumerable: true, writable: true, value }); },
      });
    }
  }
  return () => touched;
}
