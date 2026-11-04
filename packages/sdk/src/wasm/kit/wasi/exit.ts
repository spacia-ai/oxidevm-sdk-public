import { MAX_EXACT_EXIT } from "./limits.js";

/** How a guest proc_exit code leaves the module: exact up to 119, otherwise status 1 with the original code reported. */
export type ExitMapping = { readonly status: number; readonly diagnostic?: string };

export function mapGuestExit(code: number, argv0: string): ExitMapping {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff_ffff) throw new RangeError(`invalid guest exit code ${String(code)}`);
  if (code <= MAX_EXACT_EXIT) return { status: code };
  return { status: 1, diagnostic: `${argv0}: the program exited with status ${String(code)}, which a module command cannot report exactly (0-${String(MAX_EXACT_EXIT)}); reporting 1` };
}
