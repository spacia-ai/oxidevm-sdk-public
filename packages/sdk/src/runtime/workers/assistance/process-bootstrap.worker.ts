import { record } from "../../decode.js";
import { decodeProcessStart } from "./process-start.js";

declare const ASSISTANCE_RUNTIME_SHA256: string;

// This small static worker is trusted bootstrap code. It has no network or
// module-loading capability; executable bytes arrive from its trusted broker.
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void bootstrap(event.data).catch((error: unknown) => { queueMicrotask(() => { throw error; }); });
}, { once: true });

async function bootstrap(value: unknown): Promise<void> {
  const input = record(value, "process artifact bootstrap");
  const { runtimeBytes, ...startup } = input;
  const start = decodeProcessStart(startup);
  if (!(runtimeBytes instanceof ArrayBuffer) || runtimeBytes.byteLength === 0 || runtimeBytes.byteLength > 4 * 1024 * 1024) {
    throw new TypeError("Invalid process runtime artifact");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", runtimeBytes));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== ASSISTANCE_RUNTIME_SHA256) {
    throw new Error("Process runtime integrity mismatch");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(runtimeBytes);
  // ADR 0012: verified code is evaluated only inside the isolated process worker.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(`${source}\nreturn OxideVMAssistedProcess;`);
  const runtime = record(Reflect.apply(evaluate, undefined, []), "process runtime exports");
  const initialize = runtime["startProcess"];
  if (typeof initialize !== "function") throw new TypeError("Process runtime has no entrypoint");
  Reflect.apply(initialize, undefined, [start]);
}
