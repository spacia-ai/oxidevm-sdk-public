import { exactKeys, record } from "../../src/runtime/decode.ts";
import { serializeUnknownError, VMError } from "../../src/runtime/errors.ts";

let attached = false;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || attached) return;
  const input = record(event.data, "native execution bootstrap");
  exactKeys(input, ["version", "type", "nonce", "port"]);
  if (input["version"] !== 1 || input["type"] !== "native-bootstrap" || typeof input["nonce"] !== "string" || !(input["port"] instanceof MessagePort)) return;
  attached = true;
  const port = input["port"], nonce = input["nonce"];
  if (!crossOriginIsolated) { port.postMessage({ version: 1, type: "failure", nonce, error: serializeUnknownError(new VMError("FEATURE_NOT_AVAILABLE", "Execution origin is not cross-origin isolated")) }); port.close(); return; }
  const broker = new Worker(new URL("../../src/runtime/workers/native-node-api/broker.worker.ts", import.meta.url), { type: "module", name: "oxidevm-native-broker" });
  broker.postMessage({ version: 1, port, nonce }, [port]);
  window.addEventListener("pagehide", () => { broker.terminate(); }, { once: true });
});
