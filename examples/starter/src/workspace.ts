import { VMError } from "@oxidevm/sdk";

/**
 * Whether a VM did not start because its saved workspace was made with an image signed by another key, such as the
 * starter's 0.0.1 image. Starting it again with `restorePoint: "update-image"` moves the workspace to the configured
 * image and keeps its files.
 */
export function savedWithAnotherImageKey(value: unknown): boolean {
  return value instanceof VMError && value.code === "PROTOCOL_ERROR" && value.detail?.["reason"] === "image-trust-changed";
}
