import { PROTOCOL_VERSION, type SnapshotEventRecord } from "../../protocol.js";

/** The pages that follow a VM's restore points, each through the port it gave the control worker. */
export class SnapshotEvents {
  readonly #ports = new Set<MessagePort>();

  listen(port: MessagePort): void {
    this.#ports.add(port);
  }

  /** Sends `event` to every page that listens. */
  broadcast(event: SnapshotEventRecord): void {
    for (const port of this.#ports) port.postMessage({ version: PROTOCOL_VERSION, event });
  }

  close(): void {
    for (const port of this.#ports) port.close();
    this.#ports.clear();
  }
}
