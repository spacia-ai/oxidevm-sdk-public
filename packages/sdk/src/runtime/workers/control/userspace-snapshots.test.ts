import { expect, it } from "vitest";
import { UserspaceSnapshotControl } from "./userspace-snapshots.js";
import { decodeNativeCheckpointConnection, decodeNativeCheckpointRequest } from "../../protocol/userspace-checkpoints.js";
import { PROTOCOL_VERSION, type SnapshotEventRecord } from "../../protocol.js";

const JS_PROCESS_ACTIVE = { code: "FEATURE_NOT_AVAILABLE", message: "Snapshots and suspend cannot capture a live JS process", detail: { reason: "js-process-active" } };

it("settles cancellation through the native owner and keeps progress separate from request identities", async () => {
  const storage = new MessageChannel(), events: SnapshotEventRecord[] = [];
  let receiving: ReturnType<typeof decodeNativeCheckpointConnection> | undefined;
  const control = new UserspaceSnapshotControl({ postMessage: message => { receiving = decodeNativeCheckpointConnection(message); } }, storage.port1, event => events.push(event));
  if (receiving === undefined) throw new Error("checkpoint channel missing");
  const connection = receiving;
  connection.port.start();
  const captured = Promise.withResolvers<number>();
  connection.port.addEventListener("message", (message: MessageEvent<unknown>) => {
    const request = decodeNativeCheckpointRequest(message.data);
    if (request.type === "cancel") {
      connection.port.postMessage({ version: PROTOCOL_VERSION, id: request.requestId, ok: false, error: { code: "ABORTED", message: "cancelled before publication" } });
    } else captured.resolve(request.id);
  });
  const saving = control.capture(14, { kind: "named", label: "test" });
  await captured.promise;
  connection.eventsPort.postMessage({ version: PROTOCOL_VERSION, event: { type: "restore-progress", completedBytes: 0, totalBytes: 5 } });
  control.cancel(14);
  await expect(saving).rejects.toMatchObject({ code: "ABORTED" });
  expect(events).toContainEqual({ type: "save-started", kind: "named" });
  expect(events.at(-1)).toMatchObject({ type: "save-failed", kind: "named", error: { code: "ABORTED" } });
  control.close(); connection.port.close(); connection.eventsPort.close(); storage.port1.close(); storage.port2.close();
});

/** A control whose native owner prepares and reports dirty state at once and refuses every capture as busy. */
function busyNativeOwner() {
  const storage = new MessageChannel(), events: SnapshotEventRecord[] = [];
  const settled = Promise.withResolvers<undefined>();
  let receiving: ReturnType<typeof decodeNativeCheckpointConnection> | undefined;
  const control = new UserspaceSnapshotControl({ postMessage: message => { receiving = decodeNativeCheckpointConnection(message); } }, storage.port1, event => {
    events.push(event);
    if (event.type === "save-failed" || event.type === "auto-save-paused") settled.resolve(undefined);
  });
  if (receiving === undefined) throw new Error("checkpoint channel missing");
  const connection = receiving;
  connection.port.start();
  connection.port.addEventListener("message", (message: MessageEvent<unknown>) => {
    const request = decodeNativeCheckpointRequest(message.data);
    if (request.type === "cancel") return;
    const answer = request.type === "capture" ? { ok: false, error: JS_PROCESS_ACTIVE } : { ok: true, value: request.type === "dirty" ? true : undefined };
    connection.port.postMessage({ version: PROTOCOL_VERSION, id: request.id, ...answer });
  });
  const close = () => { control.close(); connection.port.close(); connection.eventsPort.close(); storage.port1.close(); storage.port2.close(); };
  return { control, events, settled: settled.promise, close };
}

it("reports an automatic save refused as busy as a pause, not a failure", async () => {
  const { control, events, settled, close } = busyNativeOwner();
  control.configureAutoSave(true);
  control.hint("hidden");
  await settled;
  expect(events).toMatchObject([
    { type: "save-started", kind: "automatic" },
    { type: "auto-save-paused", reason: "busy", cause: "js-process-active" },
  ]);
  // The hidden page's save leaves the timed save where it was, two minutes after saves were turned
  // on; the pause reports the whole milliseconds until it, which the pages' decoder requires.
  const pause = events[1];
  if (pause?.type !== "auto-save-paused") throw new Error("pause missing");
  expect(Number.isSafeInteger(pause.retryInMilliseconds)).toBe(true);
  expect(pause.retryInMilliseconds).toBeGreaterThan(60_000);
  expect(pause.retryInMilliseconds).toBeLessThanOrEqual(120_000);
  close();
});

for (const kind of ["named", "safety"] as const) {
  it(`a ${kind} save refused as busy rejects to its caller`, async () => {
    const { control, events, settled, close } = busyNativeOwner();
    control.configureAutoSave(true);
    await expect(control.capture(3, { kind, label: "Before upgrading Next" })).rejects.toMatchObject(JS_PROCESS_ACTIVE);
    await settled;
    expect(events).toEqual([
      { type: "save-started", kind },
      { type: "save-failed", kind, error: JS_PROCESS_ACTIVE },
    ]);
    close();
  });
}
