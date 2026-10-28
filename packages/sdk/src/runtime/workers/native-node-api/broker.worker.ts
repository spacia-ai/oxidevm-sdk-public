import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeJSIdentity, JS_MAILBOX_BYTES, JS_MAX_OPERATION, JS_PROCESS_PROTOCOL_VERSION, NATIVE_BROKER_PROCESS_VERSION, protocol } from "../../js-process/codec.js";
import { decodeNativeProcessProgram } from "../../userspace-command-abi.js";
import { NativeThreadRouter } from "./thread-router.js";
import { NATIVE_PROCESS_BOOTSTRAP_VERSION } from "./thread-metadata.js";
import { writeWorkerMailbox } from "../../js-process/worker-mailbox.js";
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
  const local = new MessageChannel(), mailbox = new SharedArrayBuffer(JS_MAILBOX_BYTES), header = new Int32Array(mailbox, 0, 4), body = new Uint8Array(mailbox, 16);
  const pending = new Map<number, boolean>(); let upstream: MessagePort | undefined, attention: MessagePort | null = null, stopped = false;
  let routing: ReturnType<NativeThreadRouter["attach"]> | undefined;
  const stop = () => {
    if (stopped) return; stopped = true; routing?.dispose(); retired(); worker.terminate();
    // Chromium can retain a terminated worker until its synchronous wait wakes.
    Atomics.notify(header, 0);
    workers.delete(worker); local.port1.close(); upstream?.close(); attention?.close(); connection.close();
  };
  const fail = (error: unknown) => { connection.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: error instanceof Error ? error.message : "Native transport failed" }); stop(); };
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
  local.port1.onmessage = (event: MessageEvent<unknown>) => {
    try {
      if (upstream === undefined) protocol("Native service port is absent");
      const request = record(event.data, "native Linux request"); exactKeys(request, ["version", "type", "sequence", "sync", "operation", "payload"]);
      const sequence = integer(request["sequence"], "Linux request sequence", 1, 0x7fff_ffff);
      if (request["version"] !== JS_PROCESS_PROTOCOL_VERSION || request["type"] !== "request" || typeof request["sync"] !== "boolean" || !(request["payload"] instanceof Uint8Array) || request["payload"].byteLength > JS_MAILBOX_BYTES || pending.has(sequence) || pending.size >= 38) protocol("Malformed native Linux request");
      integer(request["operation"], "Linux request operation", 0, JS_MAX_OPERATION);
      pending.set(sequence, request["sync"]);
      // Shared memory stays on this origin. Rust receives the same bounded request asynchronously,
      // and the execution worker's attention counter one notice for it.
      attention?.postMessage(null);
      upstream.postMessage({ ...request, sync: false });
    } catch (error) { fail(error); }
  };
  local.port1.onmessageerror = fail; local.port1.start();
  connection.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const request = record(event.data, "native worker command");
      if (request["type"] === "stop") { exactKeys(request, ["version", "type"]); if (request["version"] !== NATIVE_BROKER_PROCESS_VERSION) protocol("Native stop version mismatch"); stop(); return; }
      exactKeys(request, ["version", "type", "value", "port", "attention"]);
      const notices = request["attention"];
      if (request["version"] !== NATIVE_BROKER_PROCESS_VERSION || request["type"] !== "start" || !(request["port"] instanceof MessagePort) || notices !== null && !(notices instanceof MessagePort) || upstream !== undefined) protocol("Invalid native startup");
      upstream = request["port"]; attention = notices;
      upstream.onmessage = (event: MessageEvent<unknown>) => {
        try {
          const reply = record(event.data, "native Linux reply"); exactKeys(reply, ["version", "type", "sequence", "errno", "value", "payload"]);
          const sequence = integer(reply["sequence"], "Linux reply sequence", 1, 0x7fff_ffff), sync = pending.get(sequence);
          if (reply["version"] !== JS_PROCESS_PROTOCOL_VERSION || reply["type"] !== "reply" || sync === undefined || typeof reply["value"] !== "bigint" || !(reply["payload"] instanceof Uint8Array) || reply["payload"].byteLength > JS_MAILBOX_BYTES - 64) protocol("Malformed native Linux reply");
          const errno = integer(reply["errno"], "Linux reply errno", 0, 4095); pending.delete(sequence);
          if (sync) writeWorkerMailbox(header, body, sequence, errno, reply["value"], reply["payload"]);
          else local.port1.postMessage(reply);
        } catch (error) { fail(error); }
      };
      upstream.onmessageerror = fail; upstream.start();
      const bootstrap = record(request["value"], "native worker startup"); exactKeys(bootstrap, ["version", "type", "port", "generation", "id", "program"]);
      const identity = decodeJSIdentity(bootstrap["generation"], bootstrap["id"]), program = decodeNativeProcessProgram(bootstrap["program"]);
      routing = threads.attach(identity, program.context, (threadControl, threadData) => {
        if (stopped) return;
        worker.postMessage({ ...bootstrap, version: NATIVE_PROCESS_BOOTSTRAP_VERSION, port: local.port2, mailbox, compilerModule, httpParserModule, threadControl, threadData }, [local.port2, threadControl, ...(threadData === null ? [] : [threadData.port, ...threadData.transfers])]);
      }, fail);
    } catch (error) { fail(error); }
  };
  connection.onmessageerror = fail; connection.start();
}
