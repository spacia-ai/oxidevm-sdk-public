import { lateFailureOf, type LateFailure } from "../../js-process/late-failure.js";
import type { LocalModuleFiles } from "./module-files.js";

/**
 * A module the fast path may not run (ADR 0026: code outside the admitted folders) is refused
 * with a typed error. A program can catch that error, as a tool does around its configuration
 * file, and then fail in its own words. The first such refusal is kept here, so the process that
 * ends in failure is reported by the module's path and the program's next run uses full Linux.
 */
export function refusingModules(modules: LocalModuleFiles): { readonly modules: LocalModuleFiles; refused(): LateFailure | undefined } {
  let refused: LateFailure | undefined;
  const keep = <Value>(work: () => Value): Value => {
    try { return work(); }
    catch (error) {
      const limitation = lateFailureOf(error);
      if (limitation?.kind === "unadmitted-module") refused ??= limitation;
      throw error;
    }
  };
  return {
    modules: { ...modules, resolve: (specifier, parent, kind) => keep(() => modules.resolve(specifier, parent, kind)), read: path => keep(() => modules.read(path)) },
    refused: () => refused,
  };
}
