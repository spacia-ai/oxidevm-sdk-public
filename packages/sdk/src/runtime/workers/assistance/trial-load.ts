import { lateFailureDetail, lateFailureOf, type TrialFailure } from "../../js-process/late-failure.js";

/** ADR 0026 trial load: opens the one add-on and runs its module initializer, and no
 * application code. Returns the exit status; a failure is reported first: the limitation an
 * error names, or the class of the error the initializer threw. */
export function probeAddon(load: (path: string) => unknown, path: string, report: (failure: TrialFailure) => void): number {
  try {
    load(path);
    return 0;
  } catch (error) {
    report(lateFailureOf(error) ?? { kind: "addon-init-threw", detail: errorClass(error) });
    return 1;
  }
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return lateFailureDetail(error.name) || "Error";
  return error === null ? "null" : typeof error;
}
