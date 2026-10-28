import { defineImage } from "../index.js";
import type { CreateVMOptions } from "../index.js";
import type { TrustedImageKey } from "../image.js";

interface ImageTestLocation {
  readonly manifestUrl: string;
  readonly manifestSHA256: string;
  readonly trust: TrustedImageKey;
}

/**
 * The VM an image test opens. A Userspace image test turns acceleration off: it qualifies the
 * image itself, and a locally staged runtime has no hosted native-execution assets to accelerate
 * with. A System test never resumes an earlier workspace.
 */
export function imageTestVMOptions(mode: "system" | "userspace", image: ImageTestLocation, workspaceId: string, signal: AbortSignal): CreateVMOptions {
  return mode === "system"
    ? { mode, image: defineImage({ mode, ...image }), workspaceId, restorePoint: "none", signal }
    : { mode, image: defineImage({ mode, ...image }), workspaceId, commandInterceptors: "off", signal };
}
