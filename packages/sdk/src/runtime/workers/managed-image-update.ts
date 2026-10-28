import { decodeManagedImageManifest, managedImageUrl, verifyManagedImageManifest } from "../managed-image.js";
import type { ImageTrust } from "../image-provenance.js";
import { VMError } from "../errors.js";
import { assertManagedImageActive, readManagedBody } from "./managed-image-fetch.js";
import { sha256Hex } from "./snapshot-content.js";

/** Explicit metadata discovery never selects a disk or acquires image payloads. */
export async function checkManagedImageUpdate(href: string, current: { readonly id: string; readonly version: string },
  options: { readonly trusted?: ImageTrust; readonly manifestSHA256?: string; readonly signal?: AbortSignal }): Promise<{ readonly id: string; readonly version: string } | null> {
  const url = managedImageUrl(href), deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 2_000);
  const signal = AbortSignal.any([deadline.signal, ...(options.signal === undefined ? [] : [options.signal])]);
  try {
    assertManagedImageActive(options.signal);
    const response = await fetch(url, { cache: "no-store", credentials: "omit", signal });
    if (!response.ok) { await response.body?.cancel(); throw new VMError("STORAGE_ERROR", `Image update manifest returned ${String(response.status)}`); }
    const bytes = await readManagedBody(response.body, 16 * 1024 ** 2, signal);
    if (options.manifestSHA256 !== undefined && await sha256Hex(bytes) !== options.manifestSHA256) throw new VMError("PROTOCOL_ERROR", "Image update manifest differs from its pin");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new VMError("PROTOCOL_ERROR", "Image update manifest is not valid JSON"); }
    const manifest = decodeManagedImageManifest(value, url);
    if (manifest.schemaVersion === 9) {
      if (options.trusted === undefined) throw new VMError("PROTOCOL_ERROR", "Signed image update requires configured trust");
      await verifyManagedImageManifest(manifest, options.trusted);
    }
    assertManagedImageActive(signal);
    return manifest.id === current.id && manifest.version === current.version ? null : { id: manifest.id, version: manifest.version };
  } catch(error) {
    assertManagedImageActive(options.signal);
    if(deadline.signal.aborted)throw new VMError("STORAGE_ERROR", "Image update check timed out");
    if(error instanceof VMError)throw error;
    throw new VMError("STORAGE_ERROR", "Image update check did not complete");
  } finally {clearTimeout(timer);}
}
