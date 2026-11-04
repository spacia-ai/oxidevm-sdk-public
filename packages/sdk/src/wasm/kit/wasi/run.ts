import { linuxErrnoOf } from "../emscripten-network.js";
import { bridgeCommand, COMMAND_FUNCTIONS } from "./bridge/command.js";
import { Handles } from "./bridge/handles.js";
import { bridgeNet, NET_FUNCTIONS, type Connection } from "./bridge/net.js";
import { bridgeProcess, PROCESS_FUNCTIONS, type Identity } from "./bridge/process.js";
import { mapGuestExit } from "./exit.js";
import type { NativeRunResult, NetSyncHost, WasiRunHost } from "./host.js";
import { GuestMemory } from "./memory.js";
import { admitProgram, AdmissionError } from "./admission.js";
import { BRIDGE_NAMESPACE, PREVIEW1_NAMESPACE } from "./imports.js";
import type { FileDescriptor } from "../../../js-process-types.js";
import type { Terminals } from "../../define.js";
import { encodeLaunch, LaunchError, preview1, ProcExit, type Preopen } from "./preview1.js";

/** The bridge functions this release serves (`oxidevm_bridge_v1`). */
export const BRIDGE_FUNCTIONS: ReadonlySet<string> = new Set([...PROCESS_FUNCTIONS, ...COMMAND_FUNCTIONS, ...NET_FUNCTIONS]);

/** The caller's side of one run: a command's `io`, or the same fields from anywhere else. */
export interface WasiIO {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly stdin: FileDescriptor;
  readonly stdout: FileDescriptor;
  readonly stderr: FileDescriptor;
  /** Which standard streams are terminals (a command's `io.terminals`); none when absent. */
  readonly terminals?: Terminals;
}
export interface WasiRunOptions {
  /** The program's argv, argv[0] included: what it sees and how diagnostics name it. */
  readonly argv: readonly [string, ...string[]];
  /** The directories the program may use; the whole VM tree (`/`) under the process's own credentials by default. */
  readonly preopens?: readonly Preopen[];
}

/** Checks a compiled program's imports and exports against the profile; throws `AdmissionError`. */
export function admit(program: WebAssembly.Module): void { admitProgram(program, BRIDGE_FUNCTIONS); }

function netPort(net: WasiRunHost["net"]): NetSyncHost | undefined {
  if (net === undefined) return undefined;
  return { connectSync: options => net.connectSync(options), connectUnixSync: path => net.connectUnixSync(path), errno: linuxErrnoOf };
}

/**
 * Runs an admitted wasm32-wasip1 program once, synchronously as far as the program can tell: a fresh instance (memory,
 * globals, table), descriptor table and bridge handles; only the compiled module is shared between runs. Resolves with
 * the module's exit status: the program's own up to 119, 1 with a diagnostic above that.
 */
export async function run(host: WasiRunHost, program: WebAssembly.Module, io: WasiIO, options: WasiRunOptions): Promise<number> {
  const argv0 = options.argv[0];
  let encoded;
  try { encoded = encodeLaunch(options.argv, io.env); }
  catch (error) { if (error instanceof LaunchError) return host.fail(2, `${argv0}: ${error.message}`); throw error; }
  // The process's identity does not change while it runs, except its parent on reparenting: read it once, before the
  // program starts (the program cannot await later).
  const info = await host.process?.info?.();
  const identity: Identity | undefined = info === undefined ? undefined : { pid: info.pid, parent: info.parentPid ?? 0, uid: info.uid, gid: info.gid };
  // Bound once the instance exists; an import called before that (a start function) finds no memory and fails.
  const bound: { memory?: GuestMemory } = {};
  const memory = (): GuestMemory => { if (bound.memory === undefined) throw new AdmissionError("memory is not bound yet"); return bound.memory; };
  const terminals = io.terminals ?? { stdin: false, stdout: false, stderr: false };
  const wasi = preview1(host, memory, { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr }, encoded, terminals, options.preopens);
  // Retained results and open connections share the run's handle budget with its descriptors.
  const handles: { results?: Handles<NativeRunResult>; connections?: Handles<Connection> } = {};
  const results = new Handles<NativeRunResult>(wasi.table, () => handles.connections?.size ?? 0);
  const connections = new Handles<Connection>(wasi.table, () => handles.results?.size ?? 0);
  handles.results = results; handles.connections = connections;
  const runSync = host.process?.runSync;
  const process = runSync === undefined ? undefined : { runSync };
  try {
    const instance = new WebAssembly.Instance(program, {
      [PREVIEW1_NAMESPACE]: wasi.imports,
      [BRIDGE_NAMESPACE]: { ...bridgeProcess(memory, identity, io.cwd), ...bridgeCommand(wasi.context, process, memory, results), ...bridgeNet(wasi.context, netPort(host.net), memory, connections) },
    });
    const exported = instance.exports["memory"], start = instance.exports["_start"];
    if (!(exported instanceof WebAssembly.Memory) || typeof start !== "function") throw new AdmissionError("the program lost its memory or _start export");
    bound.memory = new GuestMemory(exported);
    Reflect.apply(start, undefined, []);
    return 0;
  } catch (error) {
    if (!(error instanceof ProcExit)) throw error;
    const mapped = mapGuestExit(error.code, argv0);
    return mapped.diagnostic === undefined ? mapped.status : host.fail(mapped.status, mapped.diagnostic);
  } finally {
    for (const connection of connections.values()) { try { connection.socket.close(); } catch { /* the peer or the VM already closed it */ } }
    wasi.table.closeAll();
  }
}
