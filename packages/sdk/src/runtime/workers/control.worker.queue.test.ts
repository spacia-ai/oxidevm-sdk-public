import { expect, it, vi } from "vitest";
import { SystemAssistance } from "./control/assistance.js";
import { SystemSessions } from "./control/system-session.js";
import { PROTOCOL_VERSION } from "../protocol.ts";

it("answers a trace read while an ordinary request is still in flight", async () => {
  // Ordinary requests are serialized; a diagnostic read must observe a long
  // operation rather than wait behind it, or a stalled disposal cannot be
  // sampled while it stalls.
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  try {
    await import("./control.worker.ts");
    let releaseStop: (() => void) | undefined;
    const fence = vi.spyOn(SystemAssistance.prototype, "replaceGeneration").mockResolvedValue(undefined);
    const stop = vi.spyOn(SystemSessions.prototype, "stop").mockImplementation(() => new Promise<void>(resolve => { releaseStop = resolve; }));
    try {
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "stop-system", sessionId: 1 } }));
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 2, version: PROTOCOL_VERSION, type: "read-system-trace" } }));
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(1));
      const first: unknown = scope.postMessage.mock.calls[0]?.[0];
      expect(first).toMatchObject({ id: 2 });
      releaseStop?.();
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
      expect(scope.postMessage.mock.calls[1]?.[0]).toMatchObject({ id: 1 });
    } finally { fence.mockRestore(); stop.mockRestore(); }
  } finally { vi.unstubAllGlobals(); }
});
