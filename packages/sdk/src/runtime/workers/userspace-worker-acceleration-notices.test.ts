import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../protocol.ts";

it("refuses a notice subscription while the runtime runs without command acceleration", async () => {
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  try {
    await import("./userspace.worker.ts");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "acceleration-notices" } }));
    await vi.waitFor(() => { expect(scope.postMessage).toHaveBeenCalledOnce(); });
    expect(scope.postMessage.mock.calls[0]?.[0]).toMatchObject({ id: 1, ok: false, error: { code: "FEATURE_NOT_AVAILABLE" } });
  } finally { vi.unstubAllGlobals(); }
});
