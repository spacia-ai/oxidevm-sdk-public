import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeJSIdentity, NATIVE_BROKER_PROCESS_VERSION, protocol } from "../../js-process/codec.js";
import { createBrokerRelay } from "../../js-process/broker-relay.js";
import { decodeNativeProcessProgram } from "../../userspace-command-abi.js";
import { NativeThreadRouter } from "./thread-router.js";
import { NATIVE_PROCESS_BOOTSTRAP_VERSION } from "./thread-metadata.js";
// Keep the large compiler payload out of the bounded bootstrap handshake.
const modules = import("./compiler-modules.js").then(module => module.modules);
// Retain a prefetch failure for later spawns without an unhandled rejection.
void modules.catch(() => undefined);
let attached = false;
self.onmessage = (event: MessageEvent<unknown>) => {
  if (attached) protocol("Native broker is already attached"); attached = true;
  const input = record(event.data, "native broker bootstrap"); exactKeys(input, ["version", "port", "nonce"]);
  if (input["version"] !== 1 || !(input["port"] instanceof MessagePort) || typeof input["nonce"] !== "string" || !crossOriginIsolated) protocol("Invalid native broker bootstrap");
  const broker = input["port"], workers = new Set<Worker>(), threads = new NativeThreadRouter(); let reserved = 0;
  broker.onmessage = (event: MessageEvent<unknown>) => {
    const command = record(event.data, "native execution command"); exactKeys(command, ["version", "type", "pid", "port"]);
    if (!(command["port"] instanceof MessagePort)) protocol("Native process channel is absent");
    const connection = command["port"];
    try {
      if (command["version"] !== NATIVE_BROKER_PROCESS_VERSION || command["type"] !== "spawn" || reserved >= 32) protocol("Invalid native process launch");
      const pid = integer(command["pid"], "native PID", 1, 0x7fff_ffff);
      reserved++;
      void modules.then(([compiler, parser]) => {
        serve(connection, pid, workers, compiler, parser, threads, () => { reserved--; });
      }).catch((error: unknown) => { reserved--; connection.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: error instanceof Error ? error.message : "Native runtime initialization failed" }); connection.close(); });
    } catch (error) { connection.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: error instanceof Error ? error.message : "Native broker failed" }); connection.close(); }
  };
  broker.onmessageerror = () => { for (const worker of workers) worker.terminate(); workers.clear(); broker.close(); };
  broker.start(); broker.postMessage({ version: 1, type: "native-ready", nonce: input["nonce"] });
};

function serve(connection: MessagePort, pid: number, workers: Set<Worker>, compilerModule: WebAssembly.Module, httpParserModule: WebAssembly.Module, threads: NativeThreadRouter, retired: () => void): void {
  const worker = new Worker(new URL("./process.worker.ts", import.meta.url), { type: "module", name: `oxidevm-native-js-${String(pid)}` });
  workers.add(worker);
  let stopped = false, started = false;
  let routing: ReturnType<NativeThreadRouter["attach"]> | undefined;
  const stop = () => {
    if (stopped) return; stopped = true; routing?.dispose(); retired(); worker.terminate();
    workers.delete(worker); relay.close(); connection.close();
  };
  const fail = (error: unknown) => { connection.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: error instanceof Error ? error.message : "Native transport failed" }); stop(); };
  // Shared memory stays on this origin: the relay core forwards each Linux request asynchronously (broker-relay.ts).
  const relay = createBrokerRelay({ fail });
  worker.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const input = record(event.data, "native process event");
      if (input["version"] === 1 && input["type"] === "thread-online") { exactKeys(input, ["version", "type"]); routing?.online(); }
      else if (input["version"] === 1 && input["type"] === "thread-error") { exactKeys(input, ["version", "type", "error"]); routing?.error(input["error"]); }
      else if (input["version"] === 1 && input["type"] === "thread-exception") { exactKeys(input, ["version", "type", "error"]); routing?.exception(input["error"]); }
      else connection.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "message", value: input });
    } catch (error) { fail(error); }
  };
  worker.onerror = event => {
    event.preventDefault();
    console.error(JSON.stringify({ type: "native-worker-error", pid, message: event.message, file: event.filename, line: event.lineno, column: event.colno }));
    fail(new VMError("VM_FAULT", event.message));
  };
  worker.onmessageerror = fail;
  connection.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const request = record(event.data, "native worker command");
      if (request["type"] === "stop") { exactKeys(request, ["version", "type"]); if (request["version"] !== NATIVE_BROKER_PROCESS_VERSION) protocol("Native stop version mismatch"); stop(); return; }
      exactKeys(request, ["version", "type", "value", "port", "attention"]);
      const notices = request["attention"];
      if (request["version"] !== NATIVE_BROKER_PROCESS_VERSION || request["type"] !== "start" || !(request["port"] instanceof MessagePort) || notices !== null && !(notices instanceof MessagePort) || started) protocol("Invalid native startup");
      started = true; relay.attach(request["port"], notices);
      const bootstrap = record(request["value"], "native worker startup"); exactKeys(bootstrap, ["version", "type", "port", "generation", "id", "program"]);
      const identity = decodeJSIdentity(bootstrap["generation"], bootstrap["id"]), program = decodeNativeProcessProgram(bootstrap["program"]);
      routing = threads.attach(identity, program.context, (threadControl, threadData) => {
        if (stopped) return;
        worker.postMessage({ ...bootstrap, version: NATIVE_PROCESS_BOOTSTRAP_VERSION, port: relay.port, mailbox: relay.mailbox, compilerModule, httpParserModule, threadControl, threadData }, [relay.port, threadControl, ...(threadData === null ? [] : [threadData.port, ...threadData.transfers])]);
      }, fail);
    } catch (error) { fail(error); }
  };
  connection.onmessageerror = fail; connection.start();
}
