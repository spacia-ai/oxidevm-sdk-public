import { VMError } from "../errors.js";
import { encodeUserspaceDurabilityHostCompletion, type UserspaceDurabilityHostRequest } from "../userspace-abi.js";

interface Publication { flush(): Promise<void> }

/** Rust selects the filesystems and required generations. This adapter reports
 * actual storage outcomes without interpreting guest descriptors or mappings. */
export async function userspaceDurabilityCompletion(request: UserspaceDurabilityHostRequest,
  workspace: Publication, root?: Publication): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (request.root !== undefined && root === undefined) throw new VMError("STORAGE_ERROR", "Root publication is unavailable");
    const outcomes = await Promise.allSettled([
      request.workspace === undefined ? Promise.resolve() : workspace.flush(),
      request.root === undefined ? Promise.resolve() : root?.flush(),
    ]);
    for (const result of outcomes) if (result.status === "rejected") throw result.reason;
    return encodeUserspaceDurabilityHostCompletion(request.generation, request.id, { kind: "ok" });
  } catch (error) {
    const errno = error instanceof VMError && error.code === "QUOTA_EXCEEDED" ? 28
      : error instanceof VMError && error.code === "ABORTED" ? 4 : 5;
    return encodeUserspaceDurabilityHostCompletion(request.generation, request.id, { kind: "error", errno });
  }
}
