import { VMError } from "../runtime/errors.js";
import { copyKey, COPY_MISSING_REASON, type CopyKey, type ModulePin } from "../runtime/protocol/userspace-module-files.js";
import type { PinnedFile } from "./handle.js";
import type { LaunchDescriptor } from "./runner/descriptor.js";
import { ADAPTER_FILE, readPinned, type Fetcher } from "./runner/pinned.js";

/**
 * The page's half of verify-once (engine ADR 0028): the VM's verified-copy store says which pinned files it lacks, the
 * page reads only those from its own origin, within each pin's size, and sends them with the start or the enable. The
 * store hashes them before any of the module's code runs; the page hashes nothing. A file that cannot be read is
 * CORE_LOAD_FAILED `wasm-module-artifact`, naming it in `detail.file`, before anything reaches the VM.
 */

/** What the supply needs of a VM: which pins its store lacks. */
export interface ModuleFileOwner {
  readonly missing: (pins: readonly ModulePin[], signal: AbortSignal | undefined) => Promise<readonly CopyKey[]>;
}

/** The page's own `fetch`, bound late so a page that replaces it (or a test) is used. */
const pageFetch: Fetcher = (url, init) => fetch(url, { signal: init.signal });

function files(descriptor: LaunchDescriptor): readonly { readonly file: string; readonly pin: PinnedFile }[] {
  return [{ file: ADAPTER_FILE, pin: descriptor.adapter }, ...Object.entries(descriptor.artifacts).map(([file, pin]) => ({ file, pin }))];
}

/** Reads the files whose keys are `missing`, each once and in turn, so at most one is in flight. */
export async function readMissingFiles(descriptor: LaunchDescriptor, missing: readonly CopyKey[], signal: AbortSignal | undefined, fetcher: Fetcher = pageFetch): Promise<Readonly<Record<CopyKey, Blob>>> {
  const wanted = new Set<string>(missing), supplied: Record<CopyKey, Blob> = {}, live = signal ?? new AbortController().signal;
  for (const { file, pin } of files(descriptor)) {
    const key = copyKey(pin);
    if (!wanted.has(key) || Object.hasOwn(supplied, key)) continue;
    const label = file === ADAPTER_FILE ? "The adapter bundle" : `Artifact ${file}`;
    supplied[key] = new Blob([await readPinned(pin, label, file, fetcher, live)]);
  }
  if (Object.keys(supplied).length !== wanted.size) throw new VMError("PROTOCOL_ERROR", "The VM asked for a file this module does not pin");
  return supplied;
}

const lacksFiles = (error: unknown): boolean => error instanceof VMError && error.detail?.["reason"] === COPY_MISSING_REASON;

/**
 * Calls `send` with the files the VM lacks. It first sends none: the VM checks everything else first (availability,
 * names, options, bounds) and refuses with `wasm-module-copy-missing` only when its store lacks a file, so a VM that
 * cannot run the module costs no read, and one that holds every file costs none either. The supply then asks what is
 * missing, reads it and sends again; a store that dropped a file meanwhile (its last registration was turned off) gets
 * one more round.
 */
export async function withModuleFiles<T>(descriptor: LaunchDescriptor, owner: ModuleFileOwner, send: (files: Readonly<Record<CopyKey, Blob>>) => Promise<T>, signal: AbortSignal | undefined, fetcher: Fetcher = pageFetch): Promise<T> {
  try {
    return await send({});
  } catch (error: unknown) {
    if (!lacksFiles(error)) throw error;
  }
  const pins = files(descriptor).map(({ pin }) => ({ sha256: pin.sha256, bytes: pin.bytes }));
  for (let attempt = 0; ; attempt++) {
    const supplied = await readMissingFiles(descriptor, await owner.missing(pins, signal), signal, fetcher);
    try {
      return await send(supplied);
    } catch (error: unknown) {
      if (attempt > 0 || !lacksFiles(error)) throw error;
    }
  }
}
