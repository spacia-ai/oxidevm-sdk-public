import { VMError } from "./runtime/errors.js";
import { exactKeys, record } from "./runtime/decode.js";
import { isTrustworthyURL } from "./trustworthy-url.js";

/** ADR 0023 command handler. Only the managed TypeScript 6.0.2 CLI is admitted. */
export interface CommandInterceptor { readonly command: "tsc"; readonly worker: URL }
export interface CommandInterceptorRecord { readonly command: "tsc"; readonly worker: string }

export function decodeCommandInterceptors(input: unknown): readonly CommandInterceptorRecord[] {
  if (!Array.isArray(input) || input.length !== 1) throw new VMError("INVALID_ARGUMENT", "Exactly one TypeScript interceptor is supported");
  return input.map((item: unknown) => {
    const value = record(item, "command interceptor"); exactKeys(value, ["command", "worker"]);
    if (value["command"] !== "tsc") throw new VMError("INVALID_ARGUMENT", "Only tsc command interception is supported");
    const source = value["worker"];
    if (!(source instanceof URL) && typeof source !== "string") throw new VMError("INVALID_ARGUMENT", "Interceptor worker must be a URL");
    let url: URL;
    try { url = new URL(String(source)); }
    catch { throw new VMError("INVALID_ARGUMENT", "Interceptor worker URL is invalid"); }
    if (!isTrustworthyURL(url)) throw new VMError("INVALID_ARGUMENT", "Interceptor worker requires a trustworthy HTTP origin");
    return { command: "tsc", worker: url.href };
  });
}
