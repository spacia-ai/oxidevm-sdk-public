import type { ControlRequest, WorkerResponse } from "../../protocol.js";

export function responseTransfer(
  request: ControlRequest,
  response: WorkerResponse,
): Transferable[] {
  return request.type === "read-system-aot-training"
      && response.ok
      && response.value instanceof Uint8Array
    ? [response.value.buffer]
    : [];
}
