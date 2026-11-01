import { VMError } from "../../runtime/errors.js";
import type { HostArtifacts } from "../define.js";
import type { PinnedFile } from "../handle.js";
import type { LaunchDescriptor } from "./descriptor.js";

/** Stable `detail.reason` for served bytes that differ from their pin. */
export const INTEGRITY_REASON = "wasm-module-integrity";
/** Stable `detail.reason` for a pinned file that could not be fetched at all. */
export const ARTIFACT_FETCH_REASON = "wasm-module-artifact";

export type Fetcher = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Served bytes did not match their pin; the runner reports exit status 121. */
export class IntegrityError extends VMError {
  constructor(message: string) {
    super("GUEST_CRASH", message, { reason: INTEGRITY_REASON });
    this.name = "IntegrityError";
  }
}

export interface VerifiedArtifacts extends HostArtifacts {
  /** The adapter bundle, verified against its pin. */
  adapter(): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Fetches and checks every pinned artifact in turn, keeping none of them. The runner calls it before the adapter's code
   * runs, so a file that was altered after staging is refused even if the adapter never loads it through `bytes`.
   */
  verifyAll(): Promise<void>;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Fetches one pinned file, never holding more than its pin allows, and compares size and sha256. */
async function loadPinned(pin: PinnedFile, label: string, fetcher: Fetcher, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  let response: Response;
  try {
    response = await fetcher(pin.url, { signal });
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    throw new VMError("CORE_LOAD_FAILED", `${label} could not be fetched`, { reason: ARTIFACT_FETCH_REASON });
  }
  if (!response.ok) throw new VMError("CORE_LOAD_FAILED", `${label} is unavailable (HTTP ${String(response.status)})`, { reason: ARTIFACT_FETCH_REASON });
  if (response.body === null) throw new IntegrityError(`${label} has no body`);
  const bytes = new Uint8Array(pin.bytes);
  const reader = response.body.getReader();
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (length + part.value.length > pin.bytes) {
      await reader.cancel();
      throw new IntegrityError(`${label} is larger than its pin`);
    }
    bytes.set(part.value, length);
    length += part.value.length;
  }
  if (length !== pin.bytes) throw new IntegrityError(`${label} is shorter than its pin`);
  if (await sha256Hex(bytes) !== pin.sha256) throw new IntegrityError(`${label} does not match its sha256 pin`);
  return bytes;
}

/**
 * The adapter's view of its files. Every pinned file has been checked against the pins in `module.json` before the adapter's
 * code runs (`verifyAll`), and `bytes` and `compile` check again what they hand over. `url` only names the pinned
 * location: a loader that fetches its own file from it is not checked at that moment, only when the module started.
 */
export function createArtifacts(descriptor: LaunchDescriptor, fetcher: Fetcher, signal: AbortSignal): VerifiedArtifacts {
  const loaded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  function pinFor(name: string): PinnedFile {
    const pin = Object.hasOwn(descriptor.artifacts, name) ? descriptor.artifacts[name] : undefined;
    if (pin === undefined) throw new VMError("INVALID_ARGUMENT", `${name} is not an artifact of this module`);
    return pin;
  }
  function verified(key: string, pin: PinnedFile, label: string): Promise<Uint8Array<ArrayBuffer>> {
    const existing = loaded.get(key);
    if (existing !== undefined) return existing;
    const started = loadPinned(pin, label, fetcher, signal);
    loaded.set(key, started);
    return started;
  }
  return {
    adapter: () => verified("\0adapter", descriptor.adapter, "The adapter bundle"),
    verifyAll: async () => {
      for (const [name, pin] of Object.entries(descriptor.artifacts)) await loadPinned(pin, `Artifact ${name}`, fetcher, signal);
    },
    compile: async name => WebAssembly.compile(await verified(name, pinFor(name), `Artifact ${name}`)),
    bytes: async name => (await verified(name, pinFor(name), `Artifact ${name}`)).slice(),
    url: name => pinFor(name).url,
  };
}
