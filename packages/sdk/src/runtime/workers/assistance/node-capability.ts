import { VMError } from "../../errors.ts";
const NativeError = Error;

/** Retain the originating module when a Node API has no admitted browser contract. The error names a late failure
 * (ADR 0026): a program that dies of it is remembered, so its next run uses Linux; one that catches it runs on. */
export function unavailableNodeApi(api: string): never {
  const origin = new NativeError().stack?.split("\n").slice(2, 10).join("\n");
  throw new VMError("FEATURE_NOT_AVAILABLE", `${api} is unavailable in browser-assisted processes`, {
    api, lateFailure: "unavailable-builtin", subject: `node:${api}`, ...(origin === undefined ? {} : { origin: origin.slice(0, 4096) }),
  });
}
