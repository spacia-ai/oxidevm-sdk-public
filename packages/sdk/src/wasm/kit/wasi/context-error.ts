import type { WasiErrno } from "./errno.js";

/** An explicit WASI error an import returns without a host call (or after one, for a decided refusal). */
export class WasiError extends Error {
  override readonly name = "WasiError";
  constructor(readonly errno: WasiErrno) { super(`WASI errno ${String(errno)}`); }
}
