import { decodeEngineComplianceBytes, decodeEngineCompliancePin } from "./engine-compliance.js";
import type { EngineCompliancePin } from "./engine-compliance.js";
import { inOrder, type EngineLoad } from "./engine-load.js";

/**
 * Retain the same verified legal materials for hosted and explicitly self-hosted engine delivery, as part of the engine
 * `load`: the pinned compliance manifest, requested at once, then the four files it names, together, each checked
 * against its pinned size and SHA-256. Rejects with the first failure in manifest order.
 */
export async function retainEngineCompliance(base: string, reference: EngineCompliancePin | null, engineRelease: string, load: EngineLoad): Promise<void> {
  if (reference === null) return;
  const pin = decodeEngineCompliancePin(reference, engineRelease), manifestUrl = new URL(`compliance/${pin.sha256}/compliance.json`, base);
  const named = load.naming();
  const manifest = decodeEngineComplianceBytes(await load.fetch(manifestUrl, pin.sha256, pin.bytes), engineRelease);
  const files = manifest.files.map(file => load.fetch(new URL(file.name, manifestUrl), file.sha256, file.bytes));
  named();
  await inOrder(files);
}
