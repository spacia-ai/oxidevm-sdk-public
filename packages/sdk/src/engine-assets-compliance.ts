import type { BootProgress } from "./contracts.js";
import { decodeEngineComplianceBytes, decodeEngineCompliancePin } from "./engine-compliance.js";
import type { EngineCompliancePin } from "./engine-compliance.js";
import { fetchPinnedBytes } from "./pinned-assets.js";

/** Retain the same verified legal materials for hosted and explicitly self-hosted engine delivery. */
export async function retainEngineCompliance(base: string, reference: EngineCompliancePin | null, engineRelease: string, signal?: AbortSignal, progress?: (update: BootProgress) => void): Promise<void> {
  if (reference === null) return;
  const pin = decodeEngineCompliancePin(reference, engineRelease), manifestUrl = new URL(`compliance/${pin.sha256}/compliance.json`, base);
  const bytes = await fetchPinnedBytes(manifestUrl, pin.sha256, "engine", signal, progress, pin.bytes);
  const manifest = decodeEngineComplianceBytes(bytes, engineRelease);
  for (const file of manifest.files) await fetchPinnedBytes(new URL(file.name, manifestUrl), file.sha256, "engine", signal, progress, file.bytes);
}
