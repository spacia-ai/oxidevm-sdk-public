import { VMError } from "@oxidevm/sdk";

/** The stable reason of a module failure (`wasm-…`), the only detail that is safe and useful to print. */
export function wasmFailureDetail(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!(error instanceof VMError)) return undefined;
  const reason = error.detail?.["reason"];
  return typeof reason === "string" && /^wasm-[a-z0-9-]{1,64}$/u.test(reason) ? { reason } : undefined;
}
