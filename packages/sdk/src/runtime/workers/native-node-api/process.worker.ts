import * as compilerNamespace from "@swc/wasm-web";
import { exactKeys, record } from "../../decode.js";
import { serializeUnknownError, VMError } from "../../errors.js";
import { decodeJSIdentity, descriptor, JS_PROCESS_PROTOCOL_VERSION, protocol } from "../../js-process/codec.js";
import { syncFiles } from "../../js-process/files.js";
import { nativeModulePathInfo } from "./files.js";
import { process as linuxProcess, umaskOperation } from "../../js-process/process.js";
import { createProcessUmask } from "../assistance/node-process-umask.js";
import { LinuxClient } from "../../js-process/transport.js";
import { decodeNativeProcessProgram } from "../../userspace-command-abi.js";
import { initializeCompiler } from "../assistance/compiler.js";
import { restrictProcessControls } from "../assistance/process-controls.js";
import { runLocalProcess } from "../assistance/process-runtime.js";
import { NativeBridge, type NativeTransportEvent } from "./bridge.js";
import { createNativeTty } from "./tty.js";
import { NativeProcessIO } from "./process-io.js";
import { decodeThreadMetadata, NATIVE_PROCESS_BOOTSTRAP_VERSION } from "./thread-metadata.js";
import { NativeWorkers } from "./worker-threads.js";
import { nativeArguments } from "./launch-context.js";
import { createNodePath } from "../assistance/node-path.js";
import { nativeProcessBuild, nativeProcessVersions } from "./runtime-build.js";
import type { ExceptionOrigin } from "../assistance/node-exceptions.js";
import { nativePromiseCapability } from "../../promise-brand.js";
import { nativeErrorCapability } from "../../error-brand.js";

declare const ASSISTANCE_SYSTEM_SOURCE: string;
const post = self.postMessage.bind(self), diagnosticConsole = globalThis.console;
let started = false;
let applicationException: (error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>) => void = failed;
let diagnosticIdentity: { readonly generation: string; readonly process: string; readonly pid: number; readonly tid: number; readonly entry: string } | undefined;
function failed(error: unknown): void {
  const serialized = serializeUnknownError(error);
  if (typeof error === "object" && error !== null) {
    const field = (name: string): string | undefined => {
      const value: unknown = Object.getOwnPropertyDescriptor(error, name)?.value;
      return typeof value === "string" ? value.slice(0, 4096) : undefined;
    };
    const detail = Object.fromEntries(["api", "builtin", "specifier", "importer", "backend", "path"].flatMap(key => {
      const value: unknown = serialized.detail?.[key];
      return typeof value === "string" ? [[key, value.slice(0, 4096)]] : [];
    }));
    diagnosticConsole.error(JSON.stringify({ type: "native-js-failure", ...diagnosticIdentity, message: serialized.message, path: field("path"), detail }));
    try {
      const value: unknown = error instanceof Error ? error.stack : field("stack");
      const stack = typeof value === "string" ? value.slice(0, 4096) : undefined;
      if (stack !== undefined) diagnosticConsole.error(JSON.stringify({ type: "native-js-stack", ...diagnosticIdentity, stack }));
    } catch { /* Source-map formatting must not replace the original process failure. */ }
  }
  post({ version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: serialized });
}
self.onmessage = (event: MessageEvent<unknown>) => {
  if (started) protocol("A native JS worker cannot serve another process"); started = true;
  void run(event.data).catch(failed);
};
self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  event.preventDefault(); const error: unknown = event.reason; applicationException(error, "unhandledRejection", event.promise);
});
self.addEventListener("rejectionhandled", (event: PromiseRejectionEvent) => { applicationException(undefined, "rejectionHandled", event.promise); });
self.addEventListener("error", event => { event.preventDefault(); const error: unknown = event.error; applicationException(error ?? new Error(event.message), "uncaughtException"); });

async function run(input: unknown): Promise<void> {
  const start = record(input, "native process bootstrap"); exactKeys(start, ["version", "type", "port", "mailbox", "generation", "id", "program", "compilerModule", "httpParserModule", "threadControl", "threadData"]);
  if (start["version"] !== NATIVE_PROCESS_BOOTSTRAP_VERSION || start["type"] !== "start" || !(start["port"] instanceof MessagePort) || !(start["mailbox"] instanceof SharedArrayBuffer) || !(start["compilerModule"] instanceof WebAssembly.Module) || !(start["httpParserModule"] instanceof WebAssembly.Module) || !(start["threadControl"] instanceof MessagePort)) protocol("Invalid native process bootstrap");
  const identity = decodeJSIdentity(start["generation"], start["id"]), program = decodeNativeProcessProgram(start["program"]);
  if ((program.profile.requiredCapabilities & 1) !== 0 && nativePromiseCapability !== 1) protocol("Admitted native Promise capability is unavailable in this worker");
  if ((program.profile.requiredCapabilities & 2) !== 0 && nativeErrorCapability !== 2) protocol("Admitted native Error capability is unavailable in this worker");
  restrictProcessControls(self);
  const processBuild = nativeProcessBuild(program.profile);
  const thread = program.context.kind === "thread" ? program.context : null;
  const client = new LinuxClient(start["port"], start["mailbox"]), files = syncFiles(client), info = await linuxProcess(client).info();
  diagnosticIdentity = { generation: `${identity.generation}`, process: `${identity.id}`, pid: info.pid, tid: thread?.tid ?? info.pid, entry: program.entry };
  const environment = Object.fromEntries(info.environment.map(entry => { const split = entry.indexOf("="); if (split <= 0) protocol("Invalid native environment"); return [entry.slice(0, split), entry.slice(split + 1)]; }));
  const traceEnabled = environment["OXIDEVM_NODE_API_TRACE"] === "1";
  const threadData = start["threadData"] === null ? null : decodeThreadMetadata(start["threadData"]);
  const threadControl = start["threadControl"];
  if ((program.context.kind === "main") !== (threadData === null)) protocol("Native worker environment metadata mismatch");
  if (program.profile.runtime === "node" && threadData?.autoSelectFamily != null) protocol("Node workers cannot share socket defaults");
  if (program.context.kind === "fork" && threadData?.autoSelectFamily != null) protocol("Fork socket defaults must be independent");
  const autoSelectFamily = program.profile.runtime !== "bun" ? undefined : thread === null ? new SharedArrayBuffer(4) : threadData?.autoSelectFamily ?? protocol("Bun worker socket defaults are absent");
  if (autoSelectFamily !== undefined && thread === null) Atomics.store(new Int32Array(autoSelectFamily), 0, 1);
  const io = new NativeProcessIO(client, { post: value => {
    if (traceEnabled && typeof value === "object" && value !== null && Reflect.get(value, "type") === "exit") {
      const code: unknown = Reflect.get(value, "code");
      diagnosticConsole.info(JSON.stringify({ type: "native-js-exit", ...diagnosticIdentity, code, stack: new Error("JavaScript process exit").stack?.slice(0, 4096) }));
    }
    post(value);
  }, failed, externalPending: () => bridge.pending !== 0, exiting: code => bridge.dispose(code), signalExit: signal => bridge.raiseSignal(signal), fork: { control: threadControl, executable: program.profile.executable } }, thread?.stdio);
  applicationException = (error, origin, promise) => io.applicationException(error, origin, promise);
  const bridge = new NativeBridge(client, files, program.input, program.output, {
    environment: thread?.tid ?? info.pid,
    runtime: program.profile.runtime,
    signal: signal => io.receiveSignal(signal), changed: () => io.changed(), failed: error => io.fail(error), uncaught: (error, deliver) => io.applicationException(error, "uncaughtException", undefined, deliver),
    trace: frame => { if (traceEnabled) diagnosticConsole.info(JSON.stringify({ type: "native-node-api", generation: `${identity.generation}`, process: `${identity.id}`, pid: info.pid, sequence: frame.sequence, scope: `${frame.scope}`, environment: `${frame.environment}`, kind: frame.kind, operation: frame.operation })); },
    ...(traceEnabled ? { transport: (event: NativeTransportEvent) => {
      diagnosticConsole.info(JSON.stringify({ type: "native-node-api-transport", ...diagnosticIdentity, ...event }));
    } } : {}),
  });
  const allowed = new Set(program.profile.artifacts.filter(artifact => artifact.kind === "node-api").map(artifact => artifact.path)), launch = nativeArguments(info.args);
  const compiler = initializeCompiler(compilerNamespace, start["compilerModule"]);
  const versions = nativeProcessVersions(program.profile), nodeVersion = versions.node;
  let workers: NativeWorkers | undefined;
  try {
    if (traceEnabled) diagnosticConsole.info(JSON.stringify({ type: "native-node-api-js", generation: `${identity.generation}`, process: `${identity.id}`, pid: info.pid, entry: program.entry, profile: program.profile.identity, dependencies: `${program.profile.dependencyGeneration}`, runtime: program.profile.runtime, runtimeSHA256: program.profile.runtimeSHA256 }));
    bridge.watch();
    post({ version: 1, type: "thread-online" });
    await runLocalProcess({ entry: program.source.kind === "eval" ? program.source : { kind: "file", path: program.entry }, cwd: info.cwd, args: launch.args, ...(thread === null && program.source.kind === "file" ? { argvEntry: createNodePath(() => info.cwd).resolve(launch.entry) } : {}), execArgv: threadData?.execArgv ?? launch.execArgv, env: environment, ...(program.context.kind === "fork" && threadData !== null ? { ipc: threadData.port } : {}), dependencies: { generation: program.profile.dependencyGeneration, profile: program.profile.identity, roots: program.profile.roots, runtime: program.profile.runtime, moduleSearchPaths: program.profile.moduleSearchPaths } }, io, {
      socketRuntime: { runtime: program.profile.runtime, ...(autoSelectFamily === undefined ? {} : { autoSelectFamily: new Int32Array(autoSelectFamily) }) },
      contextScripts: "data", tty: createNativeTty(client),
      exactPromiseQueries: (program.profile.requiredCapabilities & 1) !== 0,
      umask: createProcessUmask(mask => client.sync(umaskOperation(mask)), program.profile.runtime, thread === null),
      modulePathInfo: path => nativeModulePathInfo(client, path),
      workerThreads: (context, scheduler, process) => { bridge.values.bindAsyncContext(context); return workers = new NativeWorkers({ client, bridge, identity, control: threadControl, thread, metadata: thread === null ? null : threadData, ...(autoSelectFamily === undefined ? {} : { autoSelectFamily }) }, context, scheduler, process); },
      compiler, systemSource: ASSISTANCE_SYSTEM_SOURCE, httpParser: start["httpParserModule"],
      metadata: { nodeVersion, execPath: program.profile.executable, argv0: program.profile.runtime === "bun" ? "node" : info.args[0] ?? program.profile.executable, versions, processBuild, isMainThread: thread === null },
      ...(thread === null ? { lateFailure: failure => { post({ version: JS_PROCESS_PROTOCOL_VERSION, type: "late-failure", failure }); } } : { unhandledException: (error: unknown) => { if (workers === undefined) protocol("Native worker runtime is absent"); post({ version: 1, type: "thread-exception", error: workers.serializeException(error) }); } }),
      loadNative: path => {
        if (!allowed.has(path)) throw new VMError("PROTOCOL_ERROR", `Unqualified native addon: ${path}`, { lateFailure: "unqualified-addon", subject: path.slice(path.lastIndexOf("/") + 1) });
        return bridge.load(path);
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && ["PROTOCOL_ERROR", "VM_FAULT", "ABORTED"].includes(String(error.code))) throw error;
    const serialized = serializeUnknownError(error);
    if (thread !== null) post({ version: 1, type: "thread-error", error: serialized });
    let text = serialized.message;
    if (error instanceof Error && typeof error.stack === "string") text = error.stack;
    files.writeAll(descriptor(thread?.stdio[2] ?? 2), new TextEncoder().encode(`${text}\n`));
    io.terminate(1);
  }
}
