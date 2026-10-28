import { expect, it } from "vitest";
import { UserspaceSnapshotControl } from "./userspace-snapshots.js";
import { decodeNativeCheckpointConnection, decodeNativeCheckpointRequest } from "../../protocol/userspace-checkpoints.js";
import { PROTOCOL_VERSION, type SnapshotEventRecord } from "../../protocol.js";

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
