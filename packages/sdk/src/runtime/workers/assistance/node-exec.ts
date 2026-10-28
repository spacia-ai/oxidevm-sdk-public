import { VMError } from "../../errors.ts";
import { BUN_DEFAULT_SEARCH_PATH, createExecFileSync, createExecSync, createSpawnSync, type SynchronousRuntime } from "./node-exec-sync.js";
import type { ProcessRuntimeIO } from "./process-io.js";

type Spawn = (...args: unknown[]) => unknown;
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function listen(target: unknown, event: string, listener: (...args: unknown[]) => void): void {
  const on: unknown = typeof target === "object" && target !== null ? Reflect.get(target, "on") : undefined;
  if (typeof on === "function") Reflect.apply(on, target, [event, listener]);
}

/** `exec` and `execFile` use the runtime's real `spawn`. Only `exec` uses
 * `/bin/sh -c`; both streams are buffered to `maxBuffer`
 * (1 MiB, as in Node), and the callback receives Node's error shape. The
 * Native synchronous file execution uses readiness-driven pipe capture. */
export function createNodeExec(spawn: Spawn, capture?: ProcessRuntimeIO["captureSync"], env: Readonly<Record<string, string>> = {}, stderr?: (bytes: Uint8Array) => void, runtime: "node" | "bun" = "node") {
  // Bun's default lookup PATH is captured before application environment changes.
  const initialPath = env["PATH"];
  const synchronous: SynchronousRuntime = runtime === "bun" ? { kind: "bun", initialPath: initialPath === undefined || initialPath === "" ? BUN_DEFAULT_SEARCH_PATH : initialPath } : { kind: "node" };
  function exec(command: unknown, options?: unknown, callback?: unknown): unknown {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof command !== "string") throw Object.assign(new TypeError("The \"command\" argument must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
    return execute("/bin/sh", ["-c", command], command, options, callback);
  }
  function execFile(file: unknown, args?: unknown, options?: unknown, callback?: unknown): unknown {
    if (!Array.isArray(args)) {
      if (args !== undefined && args !== null) { callback = options; options = args; }
      args = [];
    }
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof file !== "string" || !Array.isArray(args) || !args.every((value: unknown) => typeof value === "string")) throw Object.assign(new TypeError("Invalid executable or arguments"), { code: "ERR_INVALID_ARG_TYPE" });
    return execute(file, args, [file, ...args].join(" "), options, callback);
  }
  function execute(file: string, args: readonly unknown[], command: string, options: unknown, callback: unknown): unknown {
    if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) throw new TypeError("Invalid execution options");
    const record = typeof options === "object" && options !== null ? options : {};
    if (Object.keys(record).some(key => !["cwd", "env", "maxBuffer", "encoding"].includes(key))) throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported child execution options");
    const maxBufferOption: unknown = Reflect.get(record, "maxBuffer");
    const maxBuffer = typeof maxBufferOption === "number" ? maxBufferOption : 1024 * 1024;
    if (maxBufferOption !== undefined && (typeof maxBufferOption !== "number" || !Number.isSafeInteger(maxBuffer) || maxBuffer < 0)) throw new RangeError("Invalid maxBuffer");
    const encodingOption: unknown = Reflect.get(record, "encoding");
    if (encodingOption !== undefined && encodingOption !== "utf8" && encodingOption !== "utf-8") throw new VMError("FEATURE_NOT_AVAILABLE", "Only UTF-8 child execution output is qualified");
    const decoder = new TextDecoder();
    const cwd: unknown = Reflect.get(record, "cwd");
    const env: unknown = Reflect.get(record, "env");
    const child: unknown = spawn(file, args, { cwd, env });
    if (typeof child !== "object" || child === null) throw new VMError("PROTOCOL_ERROR", "child_process: spawn returned no child", { builtin: "child_process" });
    const chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    // shortcut: maxBuffer limits combined output; split stream quotas before admitting a workload that depends on independent limits.
    let total = 0; let killed = false; let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      const text = (parts: Uint8Array[]): string => parts.map(part => decoder.decode(part, { stream: true })).join("") + decoder.decode();
      if (typeof callback === "function") Reflect.apply(callback, undefined, [error, text(chunks.stdout), text(chunks.stderr)]);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      listen(Reflect.get(child, stream), "data", (chunk: unknown) => {
        if (settled) return;
        if (!(chunk instanceof Uint8Array)) return;
        total += chunk.byteLength;
        chunks[stream].push(chunk);
        if (total > maxBuffer && !killed) {
          killed = true;
          const kill: unknown = Reflect.get(child, "kill");
          if (typeof kill === "function") Reflect.apply(kill, child, ["SIGTERM"]);
          finish(Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", cmd: command, killed: true }));
        }
      });
    }
    listen(child, "error", (error: unknown) => { finish(error instanceof Error ? error : new Error(String(error))); });
    listen(child, "close", (code: unknown, signal: unknown) => {
      if (code === 0 && signal === null) { finish(null); return; }
      finish(Object.assign(new Error(`Command failed: ${command}`), { code, signal, cmd: command, killed }));
    });
    return child;
  }
  for (const invoke of [exec, execFile]) Object.defineProperty(invoke, Symbol.for("nodejs.util.promisify.custom"), { value: (...args: unknown[]) => {
    let child: unknown;
    const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = Reflect.apply(invoke, undefined, [...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error === null) resolve({ stdout, stderr });
        else reject(Object.assign(error, { stdout, stderr }));
      }]);
    });
    return Object.assign(promise, { child });
  } });
  const refuse = (name: string): ((...args: unknown[]) => never) => () => {
    throw new VMError("FEATURE_NOT_AVAILABLE", `child_process.${name}: synchronous child processes are not supported in the assisted process`, { builtin: "child_process", export: name });
  };
  return Object.freeze({ exec, execFile, execSync: capture === undefined ? refuse("execSync") : createExecSync(capture, env, stderr, synchronous), spawnSync: capture === undefined ? refuse("spawnSync") : createSpawnSync(capture, env, synchronous), execFileSync: capture === undefined ? refuse("execFileSync") : createExecFileSync(capture, env, stderr, undefined, synchronous) });
}
export type { ExecCallback };
