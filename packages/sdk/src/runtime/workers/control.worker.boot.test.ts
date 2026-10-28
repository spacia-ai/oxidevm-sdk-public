import { afterEach, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../protocol.ts";
import { SystemAssistance } from "./control/assistance.js";
import { AutoSave } from "./control/auto-save.js";
import { SnapshotSession } from "./control/snapshot-session.js";
import { SystemSessions } from "./control/system-session.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stops automatic saves and waits out a save under way before a managed boot quiesces the disk", async () => {
  class WorkerScope extends EventTarget {
    readonly postMessage = vi.fn();
    readonly close = vi.fn();
  }
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  const order: string[] = [];
  const saveEnds = Promise.withResolvers<undefined>();
  vi.spyOn(AutoSave.prototype, "configure").mockImplementation((policy) => {
    order.push(`automatic saves ${policy.enabled ? "on" : "off"}`);
  });
  vi.spyOn(SnapshotSession.prototype, "exclusively").mockImplementation(async (operation) => {
    // A save is under way: the boot waits for it.
    order.push("waits for the save");
    await saveEnds.promise;
    return operation();
  });
  vi.spyOn(SystemAssistance.prototype, "quiesce").mockImplementation(() => {
    order.push("quiesce");
    return Promise.resolve();
  });
  vi.spyOn(SystemSessions.prototype, "stop").mockImplementation(() => {
    order.push("stop");
    return Promise.resolve();
  });

  await import("./control.worker.ts");
  scope.dispatchEvent(new MessageEvent("message", { data: { id: 1, version: PROTOCOL_VERSION, type: "quiesce-disk" } }));
  await vi.waitFor(() => {
    expect(order).toContain("waits for the save");
  });
  expect(order).toEqual(["automatic saves off", "waits for the save"]);

  saveEnds.resolve(undefined);
  await vi.waitFor(() => {
    expect(scope.postMessage).toHaveBeenCalledOnce();
  });
  expect(order).toEqual(["automatic saves off", "waits for the save", "quiesce", "stop"]);
});
