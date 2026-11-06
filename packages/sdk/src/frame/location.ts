import { sdkVersion } from "../sdk-version.js";

// Where the runtime frame lives on its origin (ADR 0021), as run.oxidevm.dev serves it: the frame of each SDK
// release under /v/<sdkVersion>/ and each engine release under /engine/<release-id>/. The page client, the frame
// itself and the deployment doctor all take these addresses from here.

/** Spacia's hosted runtime frame. */
export const DEFAULT_FRAME_ORIGIN = "https://run.oxidevm.dev";

/** The address of this SDK release's runtime frame on `origin`. */
export function runtimeFrameUrl(origin: string): string {
  return new URL(`/v/${encodeURIComponent(sdkVersion)}/`, origin).href;
}

/** The directory from which the runtime frame at `frameUrl` loads engine release `releaseId`: its own origin's. */
export function runtimeFrameEngineUrl(frameUrl: string, releaseId: string): string {
  return new URL(`../../engine/${releaseId}/`, frameUrl).href;
}
