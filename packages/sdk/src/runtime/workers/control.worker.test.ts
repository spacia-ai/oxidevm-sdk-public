import { expect, it, vi } from "vitest";
import { SystemAssistance } from "./control/assistance.js";
import { GuestAgent } from "./control/guest-agent.js";
import { SystemSessions } from "./control/system-session.js";
import { PROTOCOL_VERSION } from "../protocol.ts";

it("closes transferred ports on malformed and duplicate control requests", async () => {
  const NativeChannel = MessageChannel;
  const channels: MessageChannel[] = [];
  class Channel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
    constructor() {
      const channel = new NativeChannel();
      channels.push(channel); this.port1 = channel.port1; this.port2 = channel.port2;
    }
  }
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  vi.stubGlobal("MessageChannel", Channel);
  try {
    await import("./control.worker.ts");
    const malformed = new MessageChannel();
    const malformedClose = vi.spyOn(malformed.port1, "close");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "assistance-attach" }, ports: [malformed.port1] }));
    expect(malformedClose).toHaveBeenCalledOnce();
    const unused = new MessageChannel();
    const unusedClose = vi.spyOn(unused.port1, "close");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 2, version: PROTOCOL_VERSION, type: "assistance-prepare" }, ports: [unused.port1] }));
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
    expect(unusedClose).toHaveBeenCalledOnce();
    const duplicate = new MessageChannel();
    const duplicateClose = vi.spyOn(duplicate.port1, "close");
    scope.dispatchEvent(new MessageEvent("message", { data: {
      id: 2, version: PROTOCOL_VERSION, type: "assistance-spawn", entry: "entry.cjs", cwd: "/", args: [], env: {}, port: duplicate.port1,
    }, ports: [duplicate.port1] }));
    expect(duplicateClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(3));
    const order: string[] = [];
    const fence = vi.spyOn(SystemAssistance.prototype, "replaceGeneration").mockImplementation(() => { order.push("fence"); return Promise.resolve(); });
    const pause = vi.spyOn(SystemSessions.prototype, "control").mockImplementation(() => { order.push("pause"); return Promise.resolve(); });
    const stop = vi.spyOn(SystemSessions.prototype, "stop").mockImplementation(() => { order.push("stop"); return Promise.resolve(); });
    try {
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 3, version: PROTOCOL_VERSION, type: "pause-system", sessionId: 1 } }));
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(4));
      expect(order).toEqual(["fence", "pause"]);
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 4, version: PROTOCOL_VERSION, type: "stop-system", sessionId: 1 } }));
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(5));
      expect(order).toEqual(["fence", "pause", "fence", "stop"]);
    } finally { fence.mockRestore(); pause.mockRestore(); stop.mockRestore(); }
    const preparation = new MessageChannel();
    const preparationClose = vi.spyOn(preparation.port1, "close");
    scope.dispatchEvent(new MessageEvent("message", { data: { id: 5, version: PROTOCOL_VERSION, type: "assistance-install",
      cwd: "/", frozenLockfile: true, workspaceBaseSha256: "a".repeat(64), port: preparation.port1 }, ports: [preparation.port1] }));
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(6));
    expect(preparationClose).toHaveBeenCalled();
    const failedAssistance = vi.spyOn(SystemAssistance.prototype, "assertHealthy").mockImplementation(() => { throw new Error("assistance fenced"); });
    const failedWorkspace = vi.spyOn(GuestAgent.prototype, "assertWorkspaceHealthy").mockImplementation(() => { throw new Error("workspace fenced"); });
    try {
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 6, version: PROTOCOL_VERSION, type: "read-system-trace" } }));
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(7));
      expect(failedAssistance).not.toHaveBeenCalled();
      expect(failedWorkspace).not.toHaveBeenCalled();
      scope.dispatchEvent(new MessageEvent("message", { data: { id: 7, version: PROTOCOL_VERSION, type: "run-system-slice", maximumSteps: 1 } }));
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(8));
      expect(failedWorkspace).toHaveBeenCalledOnce();
    } finally { failedAssistance.mockRestore(); failedWorkspace.mockRestore(); }


  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    vi.unstubAllGlobals();
  }
});
