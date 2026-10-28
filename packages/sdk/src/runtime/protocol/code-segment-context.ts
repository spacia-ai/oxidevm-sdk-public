import { VMError } from "../errors.ts";
import { integer } from "../decode.ts";
import { nonnegativeBigint } from "./decoders.ts";

export interface CodeSegmentContext {
  readonly codeSegmentBase: bigint | null;
  readonly codeSegmentLimit: number | null;
}

/** Decode normalized fetch dependencies; historical records cannot invent them. */
export function decodeCodeSegmentContext(
  base: unknown,
  limit: unknown,
  longMode: boolean,
  measured: boolean,
): CodeSegmentContext {
  if (!measured) {
    if (base !== undefined && base !== null || limit !== undefined && limit !== null) {
      throw new VMError("PROTOCOL_ERROR", "historical code-segment identity is unavailable");
    }
    return { codeSegmentBase: null, codeSegmentLimit: null };
  }
  const codeSegmentBase = nonnegativeBigint(base, "code-segment base");
  const codeSegmentLimit = integer(limit, "code-segment limit", 0, 0xffff_ffff);
  if (codeSegmentBase > 0xffff_ffff_ffff_ffffn || longMode && (codeSegmentBase !== 0n || codeSegmentLimit !== 0xffff_ffff)) {
    throw new VMError("PROTOCOL_ERROR", "code-segment addressing identity is invalid");
  }
  return { codeSegmentBase, codeSegmentLimit };
}
