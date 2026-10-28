import type { ImageInfo, ImageRef } from "./image.js";
import type { RuntimeMode } from "./values.js";
import { abortIfRequested } from "./engine-assets.js";
import { verifyImage } from "./verified-image.js";
import { exactKeys, record } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";

export function imageUpdateSignal(options: unknown): AbortSignal | undefined {
  if(options===undefined)return undefined;
  try {
    const value=record(options,"update options");exactKeys(value,[],["signal"]);
    const signal=value["signal"];
    if(signal===undefined||signal instanceof AbortSignal)return signal;
    throw new VMError("INVALID_ARGUMENT","signal must be an AbortSignal");
  } catch(error) {
    if(error instanceof VMError&&error.code==="PROTOCOL_ERROR")throw new VMError("INVALID_ARGUMENT",error.message);
    throw error;
  }
}

/** An optional offer never changes the running image or the startup result. */
export async function checkForImageUpdate(requested: ImageRef<RuntimeMode>, current: () => ImageInfo,
  base: string, signal?: AbortSignal): Promise<ImageInfo | null> {
  abortIfRequested(signal);
  const before = current();
  if (before.manifestSHA256 === requested.manifestSHA256) return null;
  const verification = AbortSignal.any([AbortSignal.timeout(2_000), ...(signal === undefined ? [] : [signal])]);
  const { info } = await verifyImage(requested, base, verification);
  abortIfRequested(signal);
  return current() !== before || info.manifestSHA256 === before.manifestSHA256 ? null : info;
}
