import { VMError } from "../../errors.ts";
const NativeError = Error;

/** Retain the originating module when a Node API has no admitted browser contract. */
export function unavailableNodeApi(api: string): never {
  const origin = new NativeError().stack?.split("\n").slice(2, 10).join("\n");
  throw new VMError("FEATURE_NOT_AVAILABLE", `${api} is unavailable in browser-assisted processes`, {
    api, ...(origin === undefined ? {} : { origin: origin.slice(0, 4096) }),
  });
}
