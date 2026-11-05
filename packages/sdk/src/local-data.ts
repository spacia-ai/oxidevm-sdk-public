import type { RuntimeOptions } from "./contracts.js";
import { exactKeys, record } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { decodePublicRuntime } from "./vm-options.js";

/**
 * Erases all OxideVM workspaces, restore points, images and IndexedDB stores of this page's
 * origin: in its own storage, or with `runtime: { hosting: "frame" }` its part of the runtime
 * frame's storage, which this page cannot reach itself; other pages' data stays. Dispose every VM
 * first; an active workspace of this origin in another tab or frame makes this fail before
 * erasure. Applications stop their own writers and clear their own preferences and caches separately.
 */
export async function eraseLocalData(options: { readonly signal?: AbortSignal; readonly runtime?: RuntimeOptions } = {}): Promise<void> {
  const input = record(options, "local data erasure options");
  exactKeys(input, [], ["signal", "runtime"]);
  const signal = input["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT", "signal must be an AbortSignal");
  const runtime = decodePublicRuntime(input["runtime"]);
  if (signal?.aborted === true) throw new VMError("ABORTED", "Local data erasure was aborted");
  if (runtime.hosting === "frame") {
    const { eraseFrameLocalData } = await import("./frame/client/erase.js");
    return eraseFrameLocalData(runtime.origin, signal);
  }
  const { eraseLocalData: eraseOrigin } = await import("./runtime/local-data.js");
  return eraseOrigin(signal === undefined ? {} : { signal });
}
