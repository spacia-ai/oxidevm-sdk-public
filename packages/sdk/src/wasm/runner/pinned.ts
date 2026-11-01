import { VMError } from "../../runtime/errors.js";
import type { PinnedFile } from "../handle.js";

/**
 * Fetching and checking one pinned file of a module release. The runner uses it for every file at every
 * application start (`spawnModule`), and the Userspace worker's module-command owner once per enable
 * (engine ADR 0027), so a file is judged the same way on both paths.
 */

/** Stable `detail.reason` for served bytes that differ from their pin. */
export const INTEGRITY_REASON = "wasm-module-integrity";
/** Stable `detail.reason` for a pinned file that could not be fetched at all. */
export const ARTIFACT_FETCH_REASON = "wasm-module-artifact";
/** The name `detail.file` gives the adapter bundle; no artifact can have it (`RESERVED_RELEASE_FILES`). */
export const ADAPTER_FILE = "adapter.mjs";

export type Fetcher = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Served bytes did not match their pin; the runner reports exit status 121. `detail.file` names the file. */
export class IntegrityError extends VMError {
  constructor(message: string, file: string) {
    super("GUEST_CRASH", message, { reason: INTEGRITY_REASON, file });
    this.name = "IntegrityError";
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches one pinned file, never holding more than its pin allows, and compares size and sha256. `label` starts the
 * messages ("Artifact tool.wasm"); `file` is the declared name every failure carries in `detail.file`. A file that cannot
 * be fetched is CORE_LOAD_FAILED `wasm-module-artifact`; bytes that differ from the pin are an `IntegrityError`.
 */
export async function loadPinned(pin: PinnedFile, label: string, file: string, fetcher: Fetcher, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  let response: Response;
  try {
    response = await fetcher(pin.url, { signal });
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    throw new VMError("CORE_LOAD_FAILED", `${label} could not be fetched`, { reason: ARTIFACT_FETCH_REASON, file });
  }
  if (!response.ok) throw new VMError("CORE_LOAD_FAILED", `${label} is unavailable (HTTP ${String(response.status)})`, { reason: ARTIFACT_FETCH_REASON, file });
  if (response.body === null) throw new IntegrityError(`${label} has no body`, file);
  const bytes = new Uint8Array(pin.bytes);
  const reader = response.body.getReader();
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (length + part.value.length > pin.bytes) {
      await reader.cancel();
      throw new IntegrityError(`${label} is larger than its pin`, file);
    }
    bytes.set(part.value, length);
    length += part.value.length;
  }
  if (length !== pin.bytes) throw new IntegrityError(`${label} is shorter than its pin`, file);
  if (await sha256Hex(bytes) !== pin.sha256) throw new IntegrityError(`${label} does not match its sha256 pin`, file);
  return bytes;
}
