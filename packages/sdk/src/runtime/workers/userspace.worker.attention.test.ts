import { expect, it, vi } from "vitest";
import { attentionAttachment, HostAttention } from "../host-attention.js";
import { PROTOCOL_VERSION } from "../protocol.ts";

it("attaches the relay's attention counter and counts each later message it receives", async () => {
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  const watch = vi.spyOn(HostAttention.prototype, "watch");
  try {
    await import("./userspace.worker.ts");
    const counter = new Int32Array(new SharedArrayBuffer(4));
    scope.dispatchEvent(new MessageEvent("message", { data: attentionAttachment(counter) }));
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    expect(watch.mock.calls[0]?.[0]).toBe("control");
    const attention = watch.mock.contexts[0];
    if (!(attention instanceof HostAttention)) throw new Error("The control channel was not watched");
    expect(scope.postMessage).not.toHaveBeenCalled();
    // What the control worker's relay does for each forwarded request: count, then post.
    Atomics.add(counter, 0, 1);
    expect(attention.pending()).toBe("control");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "listening-ports", known: null } }));
    expect(attention.pending()).toBeUndefined();
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledOnce());
    expect(scope.postMessage.mock.calls[0]?.[0]).toMatchObject({ id: 1 });
    Atomics.add(counter, 0, 1);
    scope.dispatchEvent(new MessageEvent("messageerror"));
    expect(attention.pending()).toBeUndefined();
  } finally { watch.mockRestore(); vi.unstubAllGlobals(); }
});
