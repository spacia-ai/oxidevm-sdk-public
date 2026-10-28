import { exactKeys, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { NATIVE_BROKER_PROCESS_VERSION } from "../../js-process/codec.js";

/** Actual worker and isolated-origin worker share transport/lifecycle only. */
export interface WorkerProcess {
  send(value: unknown, transfer: Transferable[]): void;
  stop(): void;
  listen(message: (value: unknown) => void, failure: (error: unknown) => void): void;
}
export function localWorkerProcess(url: string, pid: number): WorkerProcess {
  const worker = new Worker(url, { type: "module", name: `oxidevm-js-${String(pid)}` });
  return {
    send: (value, transfer) => { worker.postMessage(value, transfer); }, stop: () => { worker.terminate(); },
    listen(message, failure) {
      worker.onmessage = (event: MessageEvent<unknown>) => { message(event.data); };
      worker.onerror = event => { event.preventDefault(); failure(new VMError("VM_FAULT", event.message)); };
      worker.onmessageerror = failure;
    },
  };
}
/** A native process on the execution origin. `attention` receives one notice per Linux request the
 * broker forwards, or is null where the execution worker counts none. */
export function isolatedWorkerProcess(broker: MessagePort, pid: number, attention: MessagePort | null): WorkerProcess {
  const channel = new MessageChannel(); let closed = false;
  broker.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "spawn", pid, port: channel.port2 }, [channel.port2]);
  return {
    send(value, transfer) {
      const port = transfer[0]; if (transfer.length !== 1 || !(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Native startup requires one service port");
      channel.port1.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "start", value, port, attention }, attention === null ? [port] : [port, attention]);
    },
    stop() { if (closed) return; closed = true; channel.port1.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "stop" }); channel.port1.close(); },
    listen(message, failure) {
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        try {
          const reply = record(event.data, "isolated process reply");
          if (reply["version"] !== NATIVE_BROKER_PROCESS_VERSION) throw new VMError("PROTOCOL_ERROR", "Isolated process version mismatch");
          if (reply["type"] === "error") { exactKeys(reply, ["version", "type", "message"]); throw new VMError("VM_FAULT", string(reply["message"], "worker error")); }
          exactKeys(reply, ["version", "type", "value"]); if (reply["type"] !== "message") throw new VMError("PROTOCOL_ERROR", "Unknown isolated process reply");
          message(reply["value"]);
        } catch (error) { failure(error); }
      };
      channel.port1.onmessageerror = failure; channel.port1.start();
    },
  };
}
