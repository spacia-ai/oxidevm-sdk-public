import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { RUNNER_LAUNCH_DESCRIPTOR_BYTES } from "../js-process/launch.js";

/**
 * The module files of worker protocol 178 (engine ADR 0028, "Integrity: once per VM"). The page asks which pinned files
 * the VM's verified-copy store lacks (`module-files`), reads only those from its own origin, and sends them as Blobs with
 * the start (`spawn-module`) or the enable (`module-commands`). The Userspace worker's store checks every supplied Blob
 * against its pin before any of the module's code runs.
 */

/** Verified bytes one VM holds at once, across every holder. */
export const MODULE_COPY_BYTES = 512 * 1024 ** 2;
/** Stable `detail.reason` of a request whose pins exceed the budget. */
export const COPY_LIMIT_REASON = "wasm-module-copy-limit";
/** Stable `detail.reason` of a file neither held nor supplied: the page supplies it and asks again. */
export const COPY_MISSING_REASON = "wasm-module-copy-missing";

declare const copyKeyBrand: unique symbol;
/** A copy's identity: its pin, `<sha256>:<bytes>`. */
export type CopyKey = string & { readonly [copyKeyBrand]: "CopyKey" };

export function copyKey(pin: ModulePin): CopyKey {
  if (!/^[0-9a-f]{64}$/u.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0) throw new VMError("PROTOCOL_ERROR", "Invalid module file pin");
  const key = `${pin.sha256}:${String(pin.bytes)}`;
  return isCopyKey(key) ? key : protocol("Invalid module file pin");
}

export function isCopyKey(value: unknown): value is CopyKey {
  return typeof value === "string" && /^[0-9a-f]{64}:(?:0|[1-9][0-9]{0,15})$/u.test(value);
}

/** A launch pins its adapter and at most 64 artifacts; a module with a network reach also starts with the TLS module. */
export const MODULE_FILES_PER_REQUEST = 66;

export interface ModulePin { readonly sha256: string; readonly bytes: number }

function protocol(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

/** At most 65 pins, each a lowercase sha256 and a byte count within the copy budget. */
export function decodeModulePins(value: unknown): readonly ModulePin[] {
  if (!Array.isArray(value) || value.length > MODULE_FILES_PER_REQUEST) protocol("Module pins must be a list of at most 66");
  return Array.from<unknown>(value).map(item => {
    const pin = record(item, "module pin"); exactKeys(pin, ["sha256", "bytes"]);
    const sha256 = string(pin["sha256"], "module pin sha256");
    if (!/^[0-9a-f]{64}$/u.test(sha256)) protocol("Module pin sha256 is invalid");
    return { sha256, bytes: integer(pin["bytes"], "module pin bytes", 0, MODULE_COPY_BYTES) };
  });
}

/** The keys a store lacks: distinct, at most 66. */
export function decodeMissingKeys(value: unknown): { readonly missing: readonly CopyKey[] } {
  const result = record(value, "module-files result"); exactKeys(result, ["missing"]);
  const missing = result["missing"];
  if (!Array.isArray(missing) || missing.length > MODULE_FILES_PER_REQUEST) protocol("Missing module files must be a list of at most 66");
  const keys = Array.from<unknown>(missing).map(key => isCopyKey(key) ? key : protocol("Missing module file key is invalid"));
  if (new Set(keys).size !== keys.length) protocol("Missing module file keys repeat");
  return { missing: keys };
}

/** Supplied copies by key: at most 66 Blobs and 512 MiB, each key a pin. The store checks each Blob against its key. */
export function decodeSuppliedFiles(value: unknown): Readonly<Record<CopyKey, Blob>> {
  const files = record(value, "supplied module files"), entries = Object.entries(files);
  if (entries.length > MODULE_FILES_PER_REQUEST) protocol("At most 66 module files may be supplied at once");
  let total = 0;
  const supplied: Record<CopyKey, Blob> = {};
  for (const [key, blob] of entries) {
    if (!isCopyKey(key) || !(blob instanceof Blob)) protocol("Supplied module file is invalid");
    total += blob.size;
    if (total > MODULE_COPY_BYTES) protocol("Supplied module files exceed 512 MiB");
    supplied[key] = blob;
  }
  return supplied;
}

/** `spawnModule`'s launch description, checked for size; the worker parses it with the runner's own decoder. */
export function decodeModuleDescriptor(value: unknown): string {
  const descriptor = string(value, "module launch description");
  if (descriptor.length > RUNNER_LAUNCH_DESCRIPTOR_BYTES || new TextEncoder().encode(descriptor).byteLength > RUNNER_LAUNCH_DESCRIPTOR_BYTES) protocol("Module launch description exceeds its limit");
  return descriptor;
}
