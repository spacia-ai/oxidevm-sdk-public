import type { FileDescriptor, LinuxFiles, LinuxProcesses, LinuxSockets, LinuxSyncFiles } from "../../js-process-types.js";
import { VMError } from "../../runtime/errors.js";
import type { Capability, ClientSockets } from "../capabilities.js";
import type { HostArtifacts } from "../define.js";
import { kit } from "../kit/index.js";
import type { ResolvedOptionValues } from "../options.js";

/** The browser-facing pieces of the process, as `serveOwnedProcess` provides them. */
export interface LinuxParts {
  readonly stdin: FileDescriptor;
  readonly stdout: FileDescriptor;
  readonly stderr: FileDescriptor;
  readonly files: LinuxFiles;
  readonly filesSync: LinuxSyncFiles;
  readonly sockets: LinuxSockets;
  readonly process: LinuxProcesses;
}

/** An adapter reached for a host member that only an undeclared capability provides. */
export interface UndeclaredAccess {
  /** `process` for the whole member, `process.spawn` for one function of it. */
  readonly member: string;
  /** The capabilities that provide the member. */
  readonly capabilities: readonly Capability[];
}

export interface HostInputs {
  readonly linux: LinuxParts;
  readonly capabilities: readonly Capability[];
  readonly options: ResolvedOptionValues;
  readonly artifacts: HostArtifacts;
  readonly signal: AbortSignal;
  /** Told about each read of an undeclared member; the member itself stays absent. */
  readonly undeclared?: (access: UndeclaredAccess) => void;
}

/** Which capabilities provide each host member, and each function of `process`. */
const MEMBER_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  fs: ["files.sync"], files: ["files.async"], sockets: ["sockets.connect"], process: ["process.info", "process.spawn"],
};
const PROCESS_CAPABILITIES: Readonly<Record<string, Capability>> = {
  info: "process.info", cwd: "process.info", spawn: "process.spawn", wait: "process.spawn", signal: "process.spawn",
};

/**
 * Reports reads of members the capabilities would provide but the manifest did not declare. Reads
 * still return what the frozen object holds (undefined for an undeclared member), so behaviour is
 * unchanged; `in`, freezing and enumeration go to the object itself.
 */
function reporting<T extends object>(target: T, table: Readonly<Record<string, readonly Capability[]>>, prefix: string, report: (access: UndeclaredAccess) => void): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(table, key) && !Object.hasOwn(object, key)) report({ member: `${prefix}${key}`, capabilities: table[key] ?? [] });
      const value: unknown = Reflect.get(object, key, receiver);
      return value;
    },
  });
}

const MAX_LOG_BYTES = 8192;
const encoder = new TextEncoder();

/** Truncates to the log limit without cutting a multi-byte character. */
function boundedLine(line: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(`${line}\n`);
  if (bytes.length <= MAX_LOG_BYTES) return bytes;
  const cut = new TextDecoder().decode(bytes.subarray(0, MAX_LOG_BYTES)).replace(/�$/u, "");
  return encoder.encode(`${cut}\n`);
}

/** Client socket operations only; listening belongs to the runner. */
function clientSockets(sockets: LinuxSockets): ClientSockets {
  return Object.freeze({
    socket: sockets.socket.bind(sockets), connect: sockets.connect.bind(sockets), address: sockets.address.bind(sockets),
    read: sockets.read.bind(sockets), write: sockets.write.bind(sockets), close: sockets.close.bind(sockets), shutdown: sockets.shutdown.bind(sockets),
  });
}

/** The members the declared capabilities contribute. `process.info` and `process.spawn` both fill `process`, so they merge. */
function members(capabilities: readonly Capability[], linux: LinuxParts): Readonly<Record<string, unknown>> {
  const granted: Record<string, unknown> = {};
  if (capabilities.includes("files.sync")) granted["fs"] = linux.filesSync;
  if (capabilities.includes("files.async")) granted["files"] = linux.files;
  if (capabilities.includes("sockets.connect")) granted["sockets"] = clientSockets(linux.sockets);
  const { process } = linux;
  const info = capabilities.includes("process.info") ? { info: process.info.bind(process), cwd: process.cwd.bind(process) } : {};
  const spawn = capabilities.includes("process.spawn") ? { spawn: process.spawn.bind(process), wait: process.wait.bind(process), signal: process.signal.bind(process) } : {};
  if (capabilities.includes("process.info") || capabilities.includes("process.spawn")) granted["process"] = Object.freeze({ ...info, ...spawn });
  return granted;
}

/**
 * The object an adapter receives as `host`: the base members plus exactly the members of the
 * capabilities the manifest declares. Anything undeclared does not exist on it.
 */
export function buildHost(inputs: HostInputs): { readonly host: Readonly<Record<string, unknown>>; readonly log: (line: string) => void } {
  const { linux, signal } = inputs;
  const log = (line: string): void => {
    try { linux.filesSync.writeAll(linux.stderr, boundedLine(line)); } catch { /* a closed stderr must not fail the module */ }
  };
  const host = Object.freeze({
    signal,
    options: inputs.options,
    artifacts: inputs.artifacts,
    kit,
    stdio: Object.freeze({ stdin: linux.stdin, stdout: linux.stdout, stderr: linux.stderr }),
    log,
    fail(status: number, message: string): number {
      if (!Number.isInteger(status) || status < 1 || status > 119) throw new VMError("INVALID_ARGUMENT", "A failure status must be an integer from 1 to 119");
      log(message);
      return status;
    },
    ...members(inputs.capabilities, linux),
  });
  const report = inputs.undeclared;
  if (report === undefined) return { host, log };
  const processMember: unknown = Reflect.get(host, "process");
  const processTable = Object.fromEntries(Object.entries(PROCESS_CAPABILITIES).map(([key, capability]) => [key, [capability]]));
  const guarded = typeof processMember === "object" && processMember !== null
    ? Object.freeze({ ...host, process: reporting(processMember, processTable, "process.", report) })
    : host;
  return { host: reporting(guarded, MEMBER_CAPABILITIES, "", report), log };
}
