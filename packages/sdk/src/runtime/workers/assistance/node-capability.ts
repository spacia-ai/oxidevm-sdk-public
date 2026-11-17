import { VMError } from "../../errors.ts";
import { lateFailureDetail, type LateFailure } from "../../js-process/late-failure.ts";
const NativeError = Error;
let refused: LateFailure | undefined;

/** The Node API this process was last refused. A program that catches the refusal and then exits with a failure
 * (npm prints the error and exits 1) is reported by it, rather than by an absent export it merely read earlier. */
export function refusedNodeApi(): LateFailure | undefined { return refused; }
/** A worker runs one process; its start clears what an earlier use of the module left. */
export function clearRefusedNodeApi(): void { refused = undefined; }

/** Retain the originating module when a Node API has no admitted browser contract. The error names a late failure
 * (ADR 0026): a program that dies of it is remembered, so its next run uses Linux; one that catches it runs on. */
export function unavailableNodeApi(api: string): never {
  refused = { kind: "unavailable-builtin", detail: lateFailureDetail(`node:${api}`) };
  const origin = new NativeError().stack?.split("\n").slice(2, 10).join("\n");
  throw new VMError("FEATURE_NOT_AVAILABLE", `${api} is unavailable in browser-assisted processes`, {
    api, lateFailure: "unavailable-builtin", subject: `node:${api}`, ...(origin === undefined ? {} : { origin: origin.slice(0, 4096) }),
  });
}
