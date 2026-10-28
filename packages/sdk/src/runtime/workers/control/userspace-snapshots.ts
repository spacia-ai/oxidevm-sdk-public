import { serializeUnknownError, VMError } from "../../errors.js";
import { type AutoSaveHint, decodeSnapshotEventMessage, type OperationRequest, type OperationResponse, PROTOCOL_VERSION, type SnapshotEventRecord } from "../../protocol.js";
import { nativeCheckpointResponseDecoders, type NativeCheckpointOperations } from "../../protocol/userspace-checkpoints.js";
import { workerClientForPort, type WorkerClient } from "../../worker-client.js";
import { AutoSave } from "./auto-save.js";

/** Scheduling stays in control; the execution worker owns the frozen native state. */
export class UserspaceSnapshotControl {
  readonly #client: WorkerClient<NativeCheckpointOperations>;
  readonly #events: MessagePort;
  readonly #notify: (event: SnapshotEventRecord) => void;
  readonly #autoSave: AutoSave;
  readonly #requests = new Map<number, AbortController>();

  constructor(worker: { postMessage(message: unknown, transfer: Transferable[]): void }, snapshotPort: MessagePort, notify: (event: SnapshotEventRecord) => void) {
    this.#notify = notify;
    const requests = new MessageChannel(), events = new MessageChannel();
    this.#client = workerClientForPort(requests.port1, nativeCheckpointResponseDecoders, "settled");
    this.#events = events.port1;
    events.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
      try { notify(decodeSnapshotEventMessage(event.data)); }
      catch { this.close(new VMError("PROTOCOL_ERROR", "Invalid native checkpoint event")); }
    });
    events.port1.start();
    worker.postMessage({ version: PROTOCOL_VERSION, type: "connect-checkpoints", port: requests.port2, snapshotPort, eventsPort: events.port2 },
      [requests.port2, snapshotPort, events.port2]);
    this.#autoSave = new AutoSave({
      now: () => performance.now(), schedule: (delay, run) => { const timer = setTimeout(run, delay); return () => clearTimeout(timer); },
      prepare: signal => this.#client.request("prepare-image",{reason:"automatic"},{signal}),
      dirty: () => this.#client.request("dirty", undefined), save: () => this.capture(undefined, { kind: "automatic" }),
      collect: () => this.#client.request("collect", undefined), emit: notify,
    });
  }

  configureAutoSave(enabled: boolean): void { this.#autoSave.configure({ enabled }); }
  hint(hint: AutoSaveHint): void { this.#autoSave.hint(hint); }
  cancel(id: number): void { this.#requests.get(id)?.abort(); }
  close(reason?: VMError): void {
    this.#autoSave.configure({ enabled: false });
    this.#client.terminate(reason); this.#events.close(); this.#requests.clear();
  }

  async request<K extends keyof NativeCheckpointOperations>(id: number | undefined, operation: K,
    payload: OperationRequest<NativeCheckpointOperations, K>): Promise<OperationResponse<NativeCheckpointOperations, K>> {
    const cancellation = new AbortController();
    if (id !== undefined) this.#requests.set(id, cancellation);
    try { const result=await this.#client.request(operation, payload, { signal: cancellation.signal });if(operation==="restore")this.#autoSave.resetPreparation();return result; }
    finally { if (id !== undefined) this.#requests.delete(id); }
  }

  async capture(id: number | undefined, request: NativeCheckpointOperations["capture"]["request"]) {
    const started = performance.now();
    this.#notify({ type: "save-started", kind: request.kind });
    try {
      const saved = await this.request(id, "capture", request);
      const ended = performance.now(), durationMilliseconds = ended - started;
      this.#notify({ type: "save-finished", kind: request.kind, ...saved, durationMilliseconds });
      if (request.kind !== "automatic") this.#autoSave.saved(ended, durationMilliseconds, saved.pauseMilliseconds);
      return saved;
    } catch (error) {
      this.#notify({ type: "save-failed", kind: request.kind, error: serializeUnknownError(error) });
      throw error;
    }
  }
}
