import { lateFailureOf, type LateFailure } from "../../js-process/late-failure.js";

/**
 * An add-on file admission did not vouch for is one the fast path cannot load. To the program that
 * is Node's own failure to load a shared library (`ERR_DLOPEN_FAILED`), which is what a loader
 * probing for an optional build expects and catches; a build real Linux cannot load either, such
 * as a glibc build on a musl guest, then behaves the same in both. The limitation itself is kept:
 * when the process ends in failure it is reported, and the program's next run uses full Linux.
 */
export function refusingAddonLoader(load: (path: string) => unknown): { load(path: string): unknown; refused(): LateFailure | undefined } {
  let refused: LateFailure | undefined;
  return {
    load(path) {
      try { return load(path); }
      catch (error) {
        const limitation = lateFailureOf(error);
        if (limitation?.kind !== "unqualified-addon") throw error;
        refused ??= limitation;
        throw Object.assign(new Error(`Error loading shared library ${path}: the fast path has not admitted this add-on`), { code: "ERR_DLOPEN_FAILED" });
      }
    },
    refused: () => refused,
  };
}
