import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../protocol.ts";

// Engine ADR 0027: the page waits for the answer to a module-commands request it cancelled, because an enable may have
// registered before the cancellation arrived. The worker answers that request, where it leaves other cancelled ones be.
it("answers a module-commands request the page cancelled while its owner was working", async () => {
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  try {
    await import("./userspace.worker.ts");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "module-commands", operation: "status", registration: 3 } }));
    scope.dispatchEvent(new MessageEvent("message", { data: { version: PROTOCOL_VERSION, type: "cancel", requestId: 1 } }));
    await vi.waitFor(() => { expect(scope.postMessage).toHaveBeenCalledOnce(); });
    expect(scope.postMessage.mock.calls[0]?.[0]).toEqual({ id: 1, version: PROTOCOL_VERSION, ok: true, value: { operation: "status", enabled: false, skipped: [] } });
  } finally { vi.unstubAllGlobals(); }
});
