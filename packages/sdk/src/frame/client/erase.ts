import { VMError } from "../../runtime/errors.js";
import { decodeUnit } from "../protocol/values.js";
import { FrameChannel } from "./channel.js";
import { mountRuntimeFrame } from "./iframe.js";

/**
 * Erases the OxideVM data of the runtime frame's origin, which holds the workspaces, images and
 * restore points of every VM this page created there. A hidden frame of its own does it; VMs in
 * other frames must be disposed first, as on a self-hosted page.
 */
export async function eraseFrameLocalData(origin: string, signal?: AbortSignal): Promise<void> {
  if (!globalThis.crossOriginIsolated) {
    throw new VMError("FEATURE_NOT_AVAILABLE", "the OxideVM runtime frame needs a cross-origin isolated page", { reason: "browser-unsupported", requirement: "cross-origin-isolation" });
  }
  const frame = await mountRuntimeFrame(origin, signal);
  try { await eraseOverPort(frame.port, signal); }
  finally { frame.remove(); }
}

/** Sends the erasure over an already connected frame port and closes it afterwards. */
export async function eraseOverPort(port: MessagePort, signal?: AbortSignal): Promise<void> {
  const channel = new FrameChannel(port);
  try { await channel.request({ type: "erase-local-data" }, { decode: decodeUnit, signal }); }
  finally { channel.close(); }
}
