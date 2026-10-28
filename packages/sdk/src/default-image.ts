import { defaultImageLocations } from "./defaults.generated.js";
import { defineImage } from "./image.js";
import type { ImageLocation, ImageRef } from "./image.js";
import { VMError } from "./runtime/errors.js";
import type { RuntimeMode } from "./values.js";

/**
 * The SDK's pinned default image for `mode`: its manifest digest and author key, at its default
 * address or at `manifestUrl` when the same image is served from elsewhere (a CDN, a private
 * host). The digest and key never change with the address, so a copy cannot swap the image.
 */
export function defaultImage<M extends RuntimeMode>(mode: M, manifestUrl?: string | URL): ImageRef<M> {
  if (mode !== "userspace" && mode !== "system") throw new VMError("INVALID_ARGUMENT", "mode must be system or userspace");
  const locations: Partial<Record<RuntimeMode, ImageLocation<RuntimeMode>>> = defaultImageLocations;
  const location = locations[mode];
  if (location === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This SDK release requires an explicit image supplied with defineImage");
  return defineImage({ mode, manifestUrl: manifestUrl ?? location.manifestUrl, manifestSHA256: location.manifestSHA256, trust: location.trust });
}
