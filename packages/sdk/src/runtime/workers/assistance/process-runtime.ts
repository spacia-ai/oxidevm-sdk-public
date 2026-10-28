import type { SocketRuntime } from "./node-socket-defaults.js";
import { createNodeStreamWeb } from "./node-stream-web.ts";
import { nodeUtilTypes, exactPromiseUtilTypes } from "./node-util-types.ts";
import { createNodePerfHooks } from "./node-perf-hooks.ts";
import { createNodeDiagnosticsChannel } from "./node-diagnostics-channel.ts";
import { nodeStringDecoder } from "./node-string-decoder.ts";
import { createNodeWorkerThreads, type WorkerThreadFactory, type WorkerThreadRuntime } from "./node-worker-threads.ts";
import { nodeInspector } from "./node-inspector.ts";
import { createNodeAsyncHooks } from "./node-async-hooks.ts";
import { createNodeEvents } from "./node-events.ts";
import { createNodeBuffer } from "./node-buffer.ts";
import { createNodeTimersPromises } from "./node-timers-promises.ts";
import { createNodeExec } from "./node-exec.ts";
import { withNativeRealpath } from "./node-files-extra.ts";
import { cryptoExtras } from "./node-crypto-extra.ts";
import { createNodeFilesMore } from "./node-files-more.ts";
import { createNodeWriteStream } from "./node-write-stream.js";
import { createNodeReadStreams } from "./node-read-stream.js";
import { createNodeReadline } from "./node-readline.ts";
import { evaluateContextData } from "./node-vm-data.js";
import { createNodeVm, realmEvaluator } from "./node-vm.ts";
import { createNodeWatchers } from "./node-watch.ts";
import { createNodeZlib } from "./node-zlib-stream.ts";
import { createNodeBrotli } from "./node-brotli.ts";
import { ProcessScheduler } from "./process-scheduler.js";
import { createHttpServers } from "./node-http-server.ts";
import { createNodeHttp2 } from "./node-http2.js";
import { createNodeTls } from "./node-tls.ts";
import { createHttpClients } from "./node-http-client.ts";
import { createNodeReport } from "./node-report.js";
import { nodeV8Memory } from "./node-memory.ts";
import { nodeSqlite } from "./node-sqlite.js";
import { unavailableNodeApi } from "./node-capability.ts";
import { nodeAssert } from "./node-assert.ts";
import { createWarningPrinter } from "./node-warnings.ts";
import { NEXT_MEMORY_EXCEPTION } from "./next-memory.ts";
import { createNodeNet } from "./node-net.ts";
import { Buffer } from "buffer";
import { createProcessDirectory } from "./node-process-directory.ts";
import { nodeQuerystring } from "./node-querystring.ts";
import { createProcessKill, deliverProcessSignal, installProcessIpc, NodeProcess, validateNodeEnvironment, type ProcessBuildMetadata } from "./node-process.ts";
import { createForkedChildren } from "./node-fork.ts";
import { deliverProcessException } from "./node-exceptions.js";
import { createIpcChannel } from "./node-ipc.ts";
import type { ModuleDependencyIdentity, ModulePathInfo } from "./module-files.js";
import type { AssistanceCompiler } from "./compiler.js";
import type { ProcessRuntimeIO } from "./process-io.js";
import { createAsyncContext } from "./async-context.js";
import { installPromiseContext } from "./promise-context.js";
import { installSchedulingContext } from "./scheduling-context.js";
import { installExecutableStacks } from "./executable-stacks.js";
import { installGeneratedFunctions } from "./generated-functions.js";
import { Console, createNodeConsole } from "./node-console.ts";
import { createProcessTimers } from "./process-timers.js";
import { createSyncFiles, createAsyncFiles } from "./node-files.ts";
import { createGuestModules } from "./guest-modules.js";
import { createNativeChildren } from "./node-children.ts";
import { createNodePath } from "./node-path.ts";
import { createNodeOs, createProcessIdentity } from "./node-os.ts";
import { createNodeUrl } from "./node-url.ts";
import { createNodeDns } from "./node-dns.ts";
import { createNodeCrypto } from "./node-crypto.ts";
import { createNodeUtil, nodeUtil } from "./node-util.ts";
import { NEXT_COMPILER_BUILTIN, NEXT_COMPILER_DIRECTORY, nextCompilerEnvironment, verifyNextCompilerFacade, type NextCompilerBindings } from "./next-compiler.js";
import { createInputStream, createOutputStream, createNodeStreamModule, EventEmitter } from "./node-streams.ts";
import { createLocalModuleLoader } from "./module-loader.js";
import { lateFailureReporter, type LateFailure } from "../../js-process/late-failure.js";
import { guardMissingExports } from "./builtin-guard.ts";
import { BUN_BUILTIN_EXPORTS, NODE_BUILTIN_EXPORTS } from "./builtin-exports.generated.ts";

export interface LocalProcessStart {
  readonly entry: { readonly kind: "file"; readonly path: string } | { readonly kind: "eval"; readonly code: string };
  readonly cwd: string;
  readonly args: readonly string[];
  readonly argvEntry?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies?: ModuleDependencyIdentity;
  readonly ipc?: MessagePort;
  readonly execArgv?: readonly string[];
}

export interface ProcessRuntime {
  readonly socketRuntime?: SocketRuntime;
  readonly umask?: (mask?: unknown) => number;
  readonly modulePathInfo?: (path: string) => ModulePathInfo;
  readonly compiler: AssistanceCompiler;
  readonly systemSource: string;
  readonly httpParser: WebAssembly.Module;
  readonly metadata: {
    readonly nodeVersion: string;
    readonly execPath: string;
    readonly argv0: string;
    readonly isMainThread?: boolean;
    readonly versions?: Readonly<Record<string, string>>;
    readonly processBuild?: ProcessBuildMetadata;
  };
  readonly nextCompiler?: NextCompilerBindings;
  readonly contextScripts?: "data";
  readonly unhandledException?: (error: unknown) => void;
  /** Receives an uncaught fast-path limitation before the process exits, so Rust can remember the
   * program and its next run uses Linux (ADR 0026). */
  readonly lateFailure?: (failure: LateFailure) => void;
  readonly loadNative?: (path: string) => unknown;
  readonly exactPromiseQueries?: boolean;
  readonly workerThreads?: WorkerThreadFactory;
  readonly tty?: Readonly<Record<string, unknown>>;
}

/** The shared Node runtime uses Linux services supplied by its admitted process owner. */
export async function runLocalProcess(start: LocalProcessStart, io: ProcessRuntimeIO, runtime: ProcessRuntime): Promise<void> {
  const { compiler, systemSource, httpParser } = runtime;
  const entry = start.entry.kind === "file" ? start.entry.path : "[worker eval]";
  const sourceMapsEnabled = validateNodeEnvironment(start.env, entry, start.execArgv);
  if ((start.env["EXPERIMENTAL_DEBUG_MEMORY_USAGE"] ?? "") !== "") unavailableNodeApi("Next memory debugging");
  const context = createAsyncContext();
  const scheduler = new ProcessScheduler(context, error => io.fail(error), () => input.hasReferences || timers.hasReferences || io.hasPending || children.hasPending || forked.hasPending || ipcReferenced() || (threads?.hasPending ?? false) || stdout.writableLength !== 0 || stderr.writableLength !== 0);
  io.setCallbackScheduler(callback => scheduler.enqueue(callback));
  const restore: (() => void)[] = [];
  const nativeTimeout = globalThis.setTimeout.bind(globalThis);
  const directory = createProcessDirectory(operation => io.callSync(operation), start.cwd, runtime.metadata.isMainThread ?? true);
  const files = createSyncFiles(operation => io.callSync(operation), directory.cwd, io.copyOpenMode);
  const asynchronous = createAsyncFiles(operation => io.call(operation), directory.cwd, context, () => io.retain(), callback => scheduler.enqueue(callback), io.copyOpenMode);
  const modules = createGuestModules(files, start.dependencies, runtime.loadNative, runtime.modulePathInfo);
  const input = createInputStream(context);
  io.setInput(bytes => input.receive(bytes).catch((error: unknown) => { io.applicationException(error); }));
  const children = createNativeChildren(io, context, start.env, scheduler);
  const execArgv = [...(start.execArgv ?? [])];
  const forked = createForkedChildren(io, context, start.env, () => directory.cwd(), execArgv, { scheduler, execPath: runtime.metadata.execPath });
  let ipcReferenced = (): boolean => false;
  const stdout = createOutputStream(bytes => io.output("stdout", bytes), context);
  const stderr = createOutputStream(bytes => io.output("stderr", bytes), context);
  stdout.on("error", error => io.fail(error));
  stderr.on("error", error => io.fail(error));
  const execPath = runtime.metadata.execPath;
  const process = Object.assign(new NodeProcess(code => { lateFailures.exited(code); return io.terminate(code); }, runtime.metadata.nodeVersion, undefined, scheduler.nextTick, runtime.metadata.processBuild), {
    stdin: input.stream, stdout, stderr, nextTick: scheduler.nextTick,
    execPath,
    platform: "linux", arch: "x64",
    kill: createProcessKill(io.signalProcess?.bind(io)),
    argv: [execPath, start.argvEntry ?? entry, ...start.args],
    ...(runtime.loadNative === undefined ? {} : { report: createNodeReport(files, runtime.metadata.nodeVersion) }),
    execArgv, argv0: runtime.metadata.argv0,
    ...(runtime.metadata.versions === undefined ? {} : { versions: Object.freeze({ ...runtime.metadata.versions }) }),
    env: runtime.nextCompiler === undefined ? { ...start.env } : nextCompilerEnvironment(start.env),
    ...directory,
    ...(runtime.umask === undefined ? {} : { umask: runtime.umask }),
  });
  const processIdentity = createProcessIdentity(files);
  Object.defineProperties(process, Object.getOwnPropertyDescriptors(processIdentity));
  let threads: WorkerThreadRuntime | undefined;
  if (start.ipc !== undefined) {
    // A forked child: its parent's private channel, never the broker's port.
    const channel = createIpcChannel(start.ipc, { context, deliver: callback => scheduler.enqueue(callback),
      onMessage: value => { process.emit("message", value); }, onDisconnect: () => { process.emit("disconnect"); } });
    installProcessIpc(process, channel);
    ipcReferenced = () => channel.hasReferences;
  }
  io.setSignals(signal => scheduler.run(() => { deliverProcessSignal(process, signal, ended => { io.signalExit(ended); return io.halt(); }); }));
  if (start.env["NODE_NO_WARNINGS"] !== "1") {
    process.on("warning", createWarningPrinter(process, text => { stderr.write(text); }, () => processIdentity.pid));
  }
  const writeConsole = (stream: "stdout" | "stderr", values: readonly unknown[]): void => {
    const text = nodeUtil.format(...values);
    (stream === "stdout" ? stdout : stderr).write(`${text}\n`);
  };
  // The built-ins, created below, name the first missing export a process touched (ADR 0026).
  let touched: () => LateFailure | undefined = () => undefined;
  const lateFailures = lateFailureReporter(error => { writeConsole("stderr", [error]); }, runtime.lateFailure, () => touched());
  const printException = (error: unknown): void => { lateFailures.uncaught(error); };
  const exception: Parameters<ProcessRuntimeIO["setExceptionHandler"]>[0] = (error, origin, promise) => deliverProcessException(process, error, origin, printException, runtime.unhandledException, promise);
  scheduler.setExceptionHandler(error => exception(error, "uncaughtException"));
  io.setExceptionHandler(exception);
  function install(name: string, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, previous);
    });
  }
  restore.push(installPromiseContext(context, globalThis));
  restore.push(installSchedulingContext(context, globalThis));
  const timers = createProcessTimers(globalThis, context, callback => scheduler.enqueue(callback));
  const watchers = createNodeWatchers(io, context, scheduler);
  let streams: ReturnType<typeof createNodeStreamModule> | undefined;
  try {
    threads = runtime.workerThreads?.(context, scheduler, process);
    streams = createNodeStreamModule(context, () => io.retain(), scheduler.nextTick, { stdout, stderr });
    const timerExports = { setTimeout: timers.setTimeout, setInterval: timers.setInterval,
      clearTimeout: timers.clear, clearInterval: timers.clear, setImmediate: scheduler.setImmediate, clearImmediate: scheduler.clearImmediate };
    const console = Object.assign(createNodeConsole((stream, text) => { (stream === "stdout" ? stdout : stderr).write(`${text}\n`); }, nodeUtil.format),
      { Console: class BoundConsole extends Console { constructor(options: unknown) { super(options, nodeUtil.format); } } });
    const crypto = createNodeCrypto(() => io.retain(), scheduler);
    restore.push(crypto.restore);
    const dns = createNodeDns(children, context, stderr, callback => scheduler.enqueue(callback));
    const net = createNodeNet(io, context, scheduler, runtime.socketRuntime === undefined ? undefined : { defaults: runtime.socketRuntime, lookup: dns.lookup });
    const tls = createNodeTls(children, context, () => io.retain(), scheduler);
    const buffer = createNodeBuffer(globalThis, Buffer, runtime.socketRuntime?.runtime ?? "node");
    const nodePath = createNodePath(directory.cwd);
    const filesMore = createNodeFilesMore(asynchronous.promises);
    const util = createNodeUtil(process, line => { stderr.write(`${line}\n`); }, runtime.exactPromiseQueries === true);
    const asyncHooks = createNodeAsyncHooks(context, util);
    const events = createNodeEvents(EventEmitter, asyncHooks);
    restore.push(events.restore);
    const builtins = {
      fs: withNativeRealpath({ ...files, ...asynchronous, watch: watchers.watch, cp: filesMore.cp, ...createNodeReadStreams((path, flags) => asynchronous.promises.open(path, flags), context), createWriteStream: createNodeWriteStream((path, flags, mode) => asynchronous.promises.open(path, flags, mode), context) }), "fs/promises": { ...asynchronous.promises, ...filesMore.promises },
      tls, https: { ...createHttpClients({ createConnection: tls.connect }, httpParser, context, scheduler.nextTick, () => io.retain(), "https:"), createServer: () => unavailableNodeApi("https.createServer") },
      http2: createNodeHttp2(children, context, () => io.retain(), scheduler),
      assert: nodeAssert, "assert/strict": nodeAssert.strict, constants: files.constants,
      dns, "dns/promises": dns.promises, buffer, async_hooks: asyncHooks,
      path: nodePath, process, console, timers: timerExports, child_process: { ChildProcess: children.ChildProcess, spawn: children.spawn, fork: forked.fork, ...createNodeExec(children.spawn, io.captureSync?.bind(io), process.env, bytes => { stderr.write(bytes); }, runtime.socketRuntime?.runtime ?? "node") },
      events: events.module, stream: streams.module, "stream/promises": streams.module.promises, "stream/web": createNodeStreamWeb(globalThis),
      "timers/promises": createNodeTimersPromises(timerExports), "path/posix": nodePath.posix, readline: createNodeReadline(),
      vm: createNodeVm(realmEvaluator(), runtime.contextScripts === "data" ? (source, context, filename): unknown => evaluateContextData(source, context, filename, loader.sources) : undefined),
      "util/types": runtime.exactPromiseQueries === true ? exactPromiseUtilTypes : nodeUtilTypes, perf_hooks: createNodePerfHooks(globalThis), diagnostics_channel: createNodeDiagnosticsChannel(),
      string_decoder: nodeStringDecoder, worker_threads: threads?.module ?? createNodeWorkerThreads(globalThis), inspector: nodeInspector,
      os: createNodeOs(files, process.env, io.networkInterfaces?.bind(io)), net, http: { maxHeaderSize: 16_384, ...createHttpServers(net, httpParser, context), ...createHttpClients(net, httpParser, context, scheduler.nextTick, () => io.retain()) },
      zlib: { ...createNodeZlib(context, scheduler), ...createNodeBrotli(children, context, () => io.retain(), scheduler) },
      querystring: nodeQuerystring, url: createNodeUrl(directory.cwd), util, crypto: { ...crypto.module, ...cryptoExtras }, v8: nodeV8Memory, sqlite: nodeSqlite,
      ...(runtime.tty === undefined ? {} : { tty: runtime.tty }),
      ...(runtime.nextCompiler === undefined ? {} : { [NEXT_COMPILER_BUILTIN]: runtime.nextCompiler }),
    };
    touched = guardMissingExports(builtins, (runtime.socketRuntime?.runtime ?? "node") === "bun" ? BUN_BUILTIN_EXPORTS : NODE_BUILTIN_EXPORTS);
    const loader: ReturnType<typeof createLocalModuleLoader> = createLocalModuleLoader(compiler, systemSource, modules, builtins, directory.cwd, path => writeConsole("stderr", [
      `[oxidevm experimental ${NEXT_MEMORY_EXCEPTION}] Applied to ${path}; memory tracing, automatic heap overrides and proactive heap-threshold restart are unavailable. Dependency generation: ${start.dependencies?.generation ?? "none"}.`,
    ]));
    const setSourceMapsEnabled = (enabled: unknown): void => {
      loader.sources.setSourceMapsSupport(enabled, { nodeModules: enabled, generatedCode: enabled });
    };
    setSourceMapsEnabled(sourceMapsEnabled);
    Object.assign(process, { setSourceMapsEnabled });
    Object.defineProperty(process, "sourceMapsEnabled", { configurable: true, enumerable: true,
      get: () => loader.sources.getSourceMapsSupport().enabled });
    restore.push(installExecutableStacks(loader.sources, globalThis));
    install("process", process);
    install("global", globalThis);
    install("Buffer", Buffer);
    install("atob", buffer.atob);
    install("btoa", buffer.btoa);
    install("console", console);
    for (const [name, value] of Object.entries(timerExports)) install(name, value);
    // An installed task runs the Next profile, whose webpack development
    // output evaluates module sources through direct eval; local scripts keep
    // refusing eval so every generated source crosses the compiler boundary.
    restore.push(installGeneratedFunctions(compiler, globalThis, loader.sources, { eval: start.dependencies === undefined ? "refuse" : "native" }));
    io.ready(input.readRequested, input.closed);
    // Older guest dialects retain local-script execution without this image
    // asset. Installed tasks require the version-matched compiler handoff.
    if (runtime.nextCompiler !== undefined && start.dependencies !== undefined) verifyNextCompilerFacade(files.readFileSync(`${NEXT_COMPILER_DIRECTORY}/wasm.js`, "utf8"));
    try {
      const source = start.entry;
      if (source.kind === "eval") scheduler.run(() => loader.evaluateScript(source.code, install));
      else if (modules.read(source.path).format === "module") await loader.import(source.path);
      else scheduler.run(() => loader.require(source.path));
    } catch (error) { if (!scheduler.handleException(error)) throw error; }
    const hasWork = () => scheduler.hasPending || input.hasReferences || timers.hasReferences || io.hasPending || children.hasPending || forked.hasPending || ipcReferenced() || (threads?.hasPending ?? false) || stdout.writableLength !== 0 || stderr.writableLength !== 0;
    do {
      await scheduler.idle();
      await timers.idle();
      await io.drain();
      await children.idle();
      await forked.idle();
      await threads?.idle();
      await input.idle();
      // Let application promise continuations settle before the next idle check.
      await new Promise<void>(resolve => { nativeTimeout(resolve, 0); });
      if (!hasWork()) {
        scheduler.run(() => process.emit("beforeExit", process.exitCode ?? 0));
        // Re-enter the idle wait before a short timer can complete and hide
        // the work admitted by this listener (including browser timer clamping).
        if (hasWork()) continue;
        await new Promise<void>(resolve => { nativeTimeout(resolve, 0); });
      }
    } while (hasWork());
    process.exit();
  } finally {
    // Destroying standard streams schedules close notifications. At this point
    // process I/O may already be closed; teardown must not admit new activity.
    watchers.dispose();
    threads?.dispose();
    streams?.restore();
    context.resources.dispose();
    timers.dispose();
    scheduler.dispose();
    input.stream.destroy(); stdout.destroy(); stderr.destroy();
    for (const reset of restore.reverse()) reset();
  }
}
