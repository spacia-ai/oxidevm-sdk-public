import { AgentPayloadReader, AgentPayloadWriter, MAX_AGENT_TASK_PAYLOAD_BYTES } from "../agent-protocol.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { TextDecoder, TextEncoder } from "../web-encoding.js";

export const ASSISTANCE_LIMITS = {
  chunk: 65536, stream: 1048576, pending: 16777216, processes: 4, descriptors: 128,
  request: MAX_AGENT_TASK_PAYLOAD_BYTES,
} as const;

export interface AssistanceBinding {
  readonly session: string;
  readonly generation: number;
}
export interface AssistanceIdentity extends AssistanceBinding {
  readonly process: number;
  readonly sequence: number;
}

export interface AssistanceSocketAddress { readonly address: string; readonly port: number }
export type AssistanceSocketOperation =
  | { readonly kind: "socket-listen"; readonly address: AssistanceSocketAddress; readonly backlog: number }
  | { readonly kind: "socket-connect-local"; readonly address: AssistanceSocketAddress }
  | { readonly kind: "socket-accept" | "socket-close" | "socket-address"; readonly fd: number }
  | { readonly kind: "socket-read"; readonly fd: number; readonly length: number }
  | { readonly kind: "socket-write"; readonly fd: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "socket-shutdown"; readonly fd: number; readonly direction: "read" | "write" | "both" }
  | { readonly kind: "socket-nodelay"; readonly fd: number; readonly enabled: boolean }
  | { readonly kind: "socket-keepalive"; readonly fd: number; readonly enabled: boolean; readonly delaySeconds: number };

export type AssistanceOperation =
  | { readonly kind: "fork"; readonly process: number; readonly dependencies: Uint8Array<ArrayBuffer> | null }
  | { readonly kind: "watch-add"; readonly path: string }
  | { readonly kind: "watch-remove"; readonly watch: number }
  | { readonly kind: "watch-read" }
  | AssistanceSocketOperation
  | { readonly kind: "start"; readonly cwd: string; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: "stop" | "getcwd" }
  | { readonly kind: "chdir"; readonly path: string }
  | { readonly kind: "access"; readonly path: string; readonly mode: number }
  | { readonly kind: "check-dependencies"; readonly policy: Uint8Array<ArrayBuffer> }
  | { readonly kind: "terminal-ack"; readonly sequence: number }
  | { readonly kind: "open"; readonly path: string; readonly flags: number; readonly mode: number }
  | { readonly kind: "read"; readonly fd: number; readonly length: number; readonly offset: bigint | null }
  | { readonly kind: "write"; readonly fd: number; readonly bytes: Uint8Array<ArrayBuffer>; readonly offset: bigint | null }
  | { readonly kind: "close" | "fstat" | "fsync" | "fdatasync"; readonly fd: number }
  | { readonly kind: "stat" | "lstat" | "readdir" | "readdir-entries" | "readlink" | "realpath" | "unlink" | "rmdir"; readonly path: string }
  | { readonly kind: "mkdir" | "chmod"; readonly path: string; readonly mode: number }
  | { readonly kind: "fchmod"; readonly fd: number; readonly mode: number }
  | { readonly kind: "truncate"; readonly path: string; readonly length: bigint }
  | { readonly kind: "ftruncate"; readonly fd: number; readonly length: bigint }
  | { readonly kind: "rename" | "link"; readonly path: string; readonly destination: string }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string }
  | { readonly kind: "spawn"; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: "stdin"; readonly child: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "close-stdin"; readonly child: number }
  | { readonly kind: "signal"; readonly child: number; readonly signal: "TERM" | "KILL" | "INT" | "HUP" }
  | { readonly kind: "ack"; readonly child: number; readonly stream: "stdout" | "stderr"; readonly sequence: number; readonly bytes: number };

export interface AssistanceRequest extends AssistanceIdentity {
  readonly operation: AssistanceOperation;
}

export function isAssistanceSupervisoryOperation(operation: AssistanceOperation): boolean {
  return operation.kind === "watch-remove" || operation.kind === "socket-close" || operation.kind === "socket-shutdown" || operation.kind === "stop" || operation.kind === "ack" || operation.kind === "terminal-ack" || operation.kind === "signal";
}

export function isAssistanceSocketOperation(operation: AssistanceOperation): operation is AssistanceSocketOperation {
  return operation.kind.startsWith("socket-");
}

const SocketURL = globalThis.URL;
export function decodeAssistanceSocketAddress(value: unknown, zero = false): AssistanceSocketAddress {
  const input = record(value, "socket address");
  exactKeys(input, ["address", "port"]);
  const address = string(input["address"], "socket IP");
  if (address.length === 0 || address.length > 45 || /[^0-9a-fA-F:.]/u.test(address)) fail("Invalid socket IP address");
  if (!address.includes(":")) {
    const parts = address.split(".");
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)) fail("Invalid socket IPv4 address");
  } else {
    try { new SocketURL(`http://[${address}]/`); } catch { fail("Invalid socket IPv6 address"); }
  }
  return { address, port: integer(input["port"], "socket port", zero ? 0 : 1, 65535) };
}
export function sameSocketIp(left: string, right: string): boolean {
  const host = (value: string) => new SocketURL(`http://${value.includes(":") ? `[${value}]` : value}/`).hostname;
  return host(left) === host(right);
}
export function readAssistanceSocketAddress(input: AgentPayloadReader): unknown { return { address: input.string(), port: input.u32() }; }
export function writeAssistanceSocketAddress(output: AgentPayloadWriter, address: AssistanceSocketAddress): void { output.string(address.address).u32(address.port); }

const tags = {
  fork: 49, "watch-add": 46, "watch-remove": 47, "watch-read": 48,
  "socket-listen": 36, "socket-connect-local": 37, "socket-accept": 38, "socket-read": 39, "socket-write": 40, "socket-shutdown": 41, "socket-close": 42, "socket-address": 43, "socket-nodelay": 44, "socket-keepalive": 45,
  start: 1, stop: 2, open: 3, read: 4, write: 5, close: 6, fstat: 7,
  fsync: 8, fdatasync: 9, stat: 10, lstat: 11, readdir: 12, readlink: 13,
  realpath: 14, unlink: 15, rmdir: 16, mkdir: 17, chmod: 18, fchmod: 19,
  truncate: 20, ftruncate: 21, rename: 22, link: 23, symlink: 24,
  spawn: 25, stdin: 26, "close-stdin": 27, signal: 28, ack: 29, "terminal-ack": 30, "check-dependencies": 31, getcwd: 32, chdir: 33, access: 34, "readdir-entries": 35,
} satisfies Record<AssistanceOperation["kind"], number>;

const encoder = new TextEncoder();
function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
function id(value: unknown): number { return integer(value, "assistance identity", 1, 0xffff_ffff); }
function path(value: unknown, empty = false): string {
  const result = string(value, "assistance string");
  if ((!empty && result.length === 0) || result.length >= 4096 || result.includes("\0") || encoder.encode(result).byteLength >= 4096) fail("invalid assistance string");
  return result;
}
function size(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0x7fff_ffff_ffff_ffffn) fail("invalid assistance offset");
  return value;
}
function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength > ASSISTANCE_LIMITS.chunk) fail("invalid assistance bytes");
  return value.slice();
}

export function decodeAssistanceBinding(value: unknown): AssistanceBinding {
  const input = record(value, "assistance binding");
  exactKeys(input, ["session", "generation"]);
  const session = string(input["session"], "assistance session");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(session)) fail("invalid assistance session");
  return { session, generation: id(input["generation"]) };
}

export function decodeAssistanceIdentity(value: unknown): AssistanceIdentity {
  const input = record(value, "assistance identity");
  exactKeys(input, ["session", "generation", "process", "sequence"]);
  return { ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    process: id(input["process"]), sequence: id(input["sequence"]) };
}

export function decodeAssistanceOperation(value: unknown): AssistanceOperation {
  const input = record(value, "assistance operation");
  const kind = input["kind"];
  switch (kind) {
    case "fork": {
      exactKeys(input, ["kind", "process", "dependencies"]);
      const dependencies = input["dependencies"];
      if (dependencies !== null && (!(dependencies instanceof Uint8Array) || dependencies.byteLength !== 64)) fail("fork dependency identity must be 64 bytes or null");
      return { kind, process: id(input["process"]), dependencies: dependencies === null ? null : new Uint8Array(dependencies) };
    }
    case "watch-add": exactKeys(input, ["kind", "path"]); return { kind, path: path(input["path"]) };
    case "watch-remove": exactKeys(input, ["kind", "watch"]); return { kind, watch: id(input["watch"]) };
    case "watch-read": exactKeys(input, ["kind"]); return { kind };
    case "socket-listen": exactKeys(input, ["kind", "address", "backlog"]); return { kind, address: decodeAssistanceSocketAddress(input["address"], true), backlog: integer(input["backlog"], "socket backlog", 0, 0x7fff_ffff) };
    case "socket-connect-local": exactKeys(input, ["kind", "address"]); return { kind, address: decodeAssistanceSocketAddress(input["address"]) };
    case "socket-accept": case "socket-close": case "socket-address": exactKeys(input, ["kind", "fd"]); return { kind, fd: id(input["fd"]) };
    case "socket-read": exactKeys(input, ["kind", "fd", "length"]); return { kind, fd: id(input["fd"]), length: integer(input["length"], "socket read length", 0, ASSISTANCE_LIMITS.chunk) };
    case "socket-write": exactKeys(input, ["kind", "fd", "bytes"]); return { kind, fd: id(input["fd"]), bytes: bytes(input["bytes"]) };
    case "socket-shutdown": {
      exactKeys(input, ["kind", "fd", "direction"]);
      const direction = input["direction"];
      if (direction !== "read" && direction !== "write" && direction !== "both") fail("Invalid socket shutdown direction");
      return { kind, fd: id(input["fd"]), direction };
    }
    case "socket-keepalive": {
      exactKeys(input, ["kind", "fd", "enabled", "delaySeconds"]);
      const enabled = input["enabled"];
      if (typeof enabled !== "boolean") fail("Invalid socket boolean");
      return { kind, fd: id(input["fd"]), enabled, delaySeconds: integer(input["delaySeconds"], "socket keepalive delay", 0, 0xffff_ffff) };
    }
    case "socket-nodelay": {
      exactKeys(input, ["kind", "fd", "enabled"]);
      const enabled = input["enabled"];
      if (typeof enabled !== "boolean") fail("Invalid socket boolean");
      return { kind, fd: id(input["fd"]), enabled };
    }
    case "start": exactKeys(input, ["kind", "cwd", "env"]); return { kind, cwd: path(input["cwd"]), env: decodeAssistanceEnvironment(input["env"]) };
    case "getcwd": case "stop": exactKeys(input, ["kind"]); return { kind };
    case "check-dependencies": {
      exactKeys(input, ["kind", "policy"]);
      const policy = bytes(input["policy"]);
      if (policy.length === 0 || policy.includes(0)) fail("invalid dependency admission policy");
      try { new TextDecoder("utf-8", { fatal: true }).decode(policy); }
      catch { fail("invalid dependency admission policy"); }
      return { kind, policy };
    }
    case "access": exactKeys(input, ["kind", "path", "mode"]); return { kind, path: path(input["path"]), mode: integer(input["mode"], "access mode", 0, 7) };
    case "chdir": exactKeys(input, ["kind", "path"]); return { kind, path: path(input["path"], true) };
    case "terminal-ack":
      exactKeys(input, ["kind", "sequence"]); return { kind, sequence: id(input["sequence"]) };
    case "open":
      exactKeys(input, ["kind", "path", "flags", "mode"]);
      return { kind, path: path(input["path"]), flags: integer(input["flags"], "open flags", 0, 9), mode: integer(input["mode"], "mode", 0, 0o7777) };
    case "read":
      exactKeys(input, ["kind", "fd", "length", "offset"]);
      return { kind, fd: id(input["fd"]), length: integer(input["length"], "read length", 0, ASSISTANCE_LIMITS.chunk), offset: input["offset"] === null ? null : size(input["offset"]) };
    case "write":
      exactKeys(input, ["kind", "fd", "bytes", "offset"]);
      return { kind, fd: id(input["fd"]), bytes: bytes(input["bytes"]), offset: input["offset"] === null ? null : size(input["offset"]) };
    case "close": case "fstat": case "fsync": case "fdatasync":
      exactKeys(input, ["kind", "fd"]); return { kind, fd: id(input["fd"]) };
    case "stat": case "lstat": case "readdir": case "readdir-entries": case "readlink": case "realpath": case "unlink": case "rmdir":
      exactKeys(input, ["kind", "path"]); return { kind, path: path(input["path"]) };
    case "mkdir": case "chmod":
      exactKeys(input, ["kind", "path", "mode"]); return { kind, path: path(input["path"]), mode: integer(input["mode"], "mode", 0, 0o7777) };
    case "fchmod":
      exactKeys(input, ["kind", "fd", "mode"]); return { kind, fd: id(input["fd"]), mode: integer(input["mode"], "mode", 0, 0o7777) };
    case "truncate":
      exactKeys(input, ["kind", "path", "length"]); return { kind, path: path(input["path"]), length: size(input["length"]) };
    case "ftruncate":
      exactKeys(input, ["kind", "fd", "length"]); return { kind, fd: id(input["fd"]), length: size(input["length"]) };
    case "rename": case "link":
      exactKeys(input, ["kind", "path", "destination"]); return { kind, path: path(input["path"]), destination: path(input["destination"]) };
    case "symlink":
      exactKeys(input, ["kind", "path", "target"]); return { kind, path: path(input["path"]), target: path(input["target"]) };
    case "spawn": {
      exactKeys(input, ["kind", "command", "args", "cwd", "env"]);
      const args: unknown = input["args"];
      if (!Array.isArray(args) || args.length > 4096) fail("invalid child arguments");
      const env = decodeAssistanceEnvironment(input["env"]);
      let remaining = ASSISTANCE_LIMITS.request - 61;
      function childString(value: unknown, empty = false): string {
        const result = path(value, empty);
        remaining -= 4 + encoder.encode(result).byteLength;
        if (remaining < 0) fail("assistance request exceeds limit");
        return result;
      }
      return { kind, command: childString(input["command"]), cwd: childString(input["cwd"]), args: args.map(value => childString(value, true)), env: Object.fromEntries(Object.entries(env).map(([key, value]) => {
        return [childString(key), childString(value, true)];
      })) };
    }
    case "stdin":
      exactKeys(input, ["kind", "child", "bytes"]); return { kind, child: id(input["child"]), bytes: bytes(input["bytes"]) };
    case "close-stdin":
      exactKeys(input, ["kind", "child"]); return { kind, child: id(input["child"]) };
    case "signal": {
      exactKeys(input, ["kind", "child", "signal"]);
      const signal = input["signal"];
      if (signal !== "TERM" && signal !== "KILL" && signal !== "INT" && signal !== "HUP") fail("invalid assistance signal");
      return { kind, child: id(input["child"]), signal };
    }
    case "ack": {
      exactKeys(input, ["kind", "child", "stream", "sequence", "bytes"]);
      const stream = input["stream"];
      if (stream !== "stdout" && stream !== "stderr") fail("invalid assistance stream");
      return { kind, child: id(input["child"]), stream, sequence: id(input["sequence"]), bytes: integer(input["bytes"], "acknowledged bytes", 1, ASSISTANCE_LIMITS.chunk) };
    }
    default: return fail("unknown assistance operation");
  }
}

/** Validate an untrusted port/mailbox request before binary encoding. */
export function encodeAssistanceRequest(value: unknown): Uint8Array<ArrayBuffer> {
  const input = record(value, "assistance request");
  exactKeys(input, ["session", "generation", "process", "sequence", "operation"]);
  const identity = decodeAssistanceIdentity({ session: input["session"], generation: input["generation"], process: input["process"], sequence: input["sequence"] });
  const operation = decodeAssistanceOperation(input["operation"]);
  const output = new AgentPayloadWriter(ASSISTANCE_LIMITS.request).string(identity.session).u32(identity.generation).u32(identity.process).u32(identity.sequence).u8(tags[operation.kind]);
  if (operation.kind === "fork" && operation.process === identity.process) fail("fork child equals parent");
  switch (operation.kind) {
    case "fork":
      output.u32(operation.process).u8(operation.dependencies === null ? 0 : 1);
      if (operation.dependencies !== null) output.bytesRaw(operation.dependencies);
      break;
    case "watch-add": output.string(operation.path); break;
    case "watch-remove": output.u32(operation.watch); break;
    case "watch-read": break;
    case "socket-listen": writeAssistanceSocketAddress(output, operation.address); output.u32(operation.backlog); break;
    case "socket-connect-local": writeAssistanceSocketAddress(output, operation.address); break;
    case "socket-accept": case "socket-close": case "socket-address": output.u32(operation.fd); break;
    case "socket-read": output.u32(operation.fd).u32(operation.length); break;
    case "socket-write": output.u32(operation.fd).bytes(operation.bytes); break;
    case "socket-shutdown": output.u32(operation.fd).u8({ read: 0, write: 1, both: 2 }[operation.direction]); break;
    case "socket-keepalive": output.u32(operation.fd).u8(operation.enabled ? 1 : 0).u32(operation.delaySeconds); break;
    case "socket-nodelay": output.u32(operation.fd).u8(operation.enabled ? 1 : 0); break;
    case "start": output.string(operation.cwd); writeAssistanceEnvironment(output, operation.env); break;
    case "getcwd": case "stop": break;
    case "access": output.string(operation.path).u8(operation.mode); break;
    case "open": output.string(operation.path).u8(operation.flags).u32(operation.mode); break;
    case "read": output.u32(operation.fd).u32(operation.length); writeOffset(output, operation.offset); break;
    case "write": output.u32(operation.fd).bytes(operation.bytes); writeOffset(output, operation.offset); break;
    case "close": case "fstat": case "fsync": case "fdatasync": output.u32(operation.fd); break;
    case "stat": case "lstat": case "readdir": case "readdir-entries": case "readlink": case "realpath": case "unlink": case "rmdir": case "chdir": output.string(operation.path); break;
    case "mkdir": case "chmod": output.string(operation.path).u32(operation.mode); break;
    case "fchmod": output.u32(operation.fd).u32(operation.mode); break;
    case "truncate": output.string(operation.path).u64(operation.length); break;
    case "ftruncate": output.u32(operation.fd).u64(operation.length); break;
    case "rename": case "link": output.string(operation.path).string(operation.destination); break;
    case "symlink": output.string(operation.path).string(operation.target); break;
    case "spawn": {
      output.string(operation.command).string(operation.cwd).u32(operation.args.length);
      for (const argument of operation.args) output.string(argument);
      writeAssistanceEnvironment(output, operation.env);
      break;
    }
    case "stdin": output.u32(operation.child).bytes(operation.bytes); break;
    case "close-stdin": output.u32(operation.child); break;
    case "signal": output.u32(operation.child).u8({ HUP: 1, INT: 2, KILL: 9, TERM: 15 }[operation.signal]); break;
    case "terminal-ack": output.u32(operation.sequence); break;
    case "check-dependencies": output.bytes(operation.policy); break;
    case "ack": output.u32(operation.child).u8(operation.stream === "stdout" ? 1 : 2).u32(operation.sequence).u32(operation.bytes); break;
  }
  const result = output.finish();
  if (result.byteLength > ASSISTANCE_LIMITS.request) fail("assistance request exceeds limit");
  return result;
}

function writeOffset(output: AgentPayloadWriter, offset: bigint | null): void {
  output.u8(offset === null ? 0 : 1);
  if (offset !== null) output.u64(offset);
}

function readOffset(input: AgentPayloadReader): bigint | null {
  switch (input.u8()) { case 0: return null; case 1: return size(input.u64()); default: return fail("invalid offset tag"); }
}

export function decodeAssistanceRequest(bytes: Uint8Array): AssistanceRequest {
  if (bytes.byteLength > ASSISTANCE_LIMITS.request) fail("assistance request exceeds limit");
  // A sender may retain a SharedArrayBuffer view. Validate an owned snapshot,
  // never fields that can change between length checks and dispatch.
  const input = new AgentPayloadReader(bytes.slice());
  const identity = decodeAssistanceIdentity({ session: input.string(), generation: input.u32(), process: input.u32(), sequence: input.u32() });
  const operation = decodeAssistanceOperation(readOperation(input));
  input.finish();
  if (operation.kind === "fork" && operation.process === identity.process) fail("fork child equals parent");
  return { ...identity, operation };
}

function readOperation(input: AgentPayloadReader): unknown {
  switch (input.u8()) {
    case 49: {
      const process = input.u32();
      const flag = input.u8();
      if (flag !== 0 && flag !== 1) fail("invalid fork dependency flag");
      return { kind: "fork", process, dependencies: flag === 1 ? new Uint8Array(input.take(64)) : null };
    }
    case 46: return { kind: "watch-add", path: input.string() };
    case 47: return { kind: "watch-remove", watch: input.u32() };
    case 48: return { kind: "watch-read" };
    case 1: return { kind: "start", cwd: input.string(), env: readAssistanceEnvironment(input) };
    case 2: return { kind: "stop" };
    case 3: return { kind: "open", path: input.string(), flags: input.u8(), mode: input.u32() };
    case 4: return { kind: "read", fd: input.u32(), length: input.u32(), offset: readOffset(input) };
    case 5: return { kind: "write", fd: input.u32(), bytes: input.bytes(), offset: readOffset(input) };
    case 6: return { kind: "close", fd: input.u32() };
    case 7: return { kind: "fstat", fd: input.u32() };
    case 8: return { kind: "fsync", fd: input.u32() };
    case 9: return { kind: "fdatasync", fd: input.u32() };
    case 10: return { kind: "stat", path: input.string() };
    case 11: return { kind: "lstat", path: input.string() };
    case 12: return { kind: "readdir", path: input.string() };
    case 13: return { kind: "readlink", path: input.string() };
    case 14: return { kind: "realpath", path: input.string() };
    case 15: return { kind: "unlink", path: input.string() };
    case 16: return { kind: "rmdir", path: input.string() };
    case 17: return { kind: "mkdir", path: input.string(), mode: input.u32() };
    case 18: return { kind: "chmod", path: input.string(), mode: input.u32() };
    case 19: return { kind: "fchmod", fd: input.u32(), mode: input.u32() };
    case 20: return { kind: "truncate", path: input.string(), length: input.u64() };
    case 21: return { kind: "ftruncate", fd: input.u32(), length: input.u64() };
    case 22: return { kind: "rename", path: input.string(), destination: input.string() };
    case 23: return { kind: "link", path: input.string(), destination: input.string() };
    case 24: return { kind: "symlink", path: input.string(), target: input.string() };
    case 25: {
      const command = input.string(); const cwd = input.string();
      const count = integer(input.u32(), "child argument count", 0, 4096);
      const args = Array.from({ length: count }, () => input.string());
      return { kind: "spawn", command, cwd, args, env: readAssistanceEnvironment(input) };
    }
    case 26: return { kind: "stdin", child: input.u32(), bytes: input.bytes() };
    case 27: return { kind: "close-stdin", child: input.u32() };
    case 28: {
      const child = input.u32();
      const signal = input.u8();
      return { kind: "signal", child, signal: signal === 1 ? "HUP" : signal === 2 ? "INT" : signal === 9 ? "KILL" : signal === 15 ? "TERM" : undefined };
    }
    case 29: {
      const child = input.u32(); const stream = input.u8();
      return { kind: "ack", child, stream: stream === 1 ? "stdout" : stream === 2 ? "stderr" : undefined, sequence: input.u32(), bytes: input.u32() };
    }
    case 30: return { kind: "terminal-ack", sequence: input.u32() };
    case 36: return { kind: "socket-listen", address: readAssistanceSocketAddress(input), backlog: input.u32() };
    case 37: return { kind: "socket-connect-local", address: readAssistanceSocketAddress(input) };
    case 38: return { kind: "socket-accept", fd: input.u32() };
    case 39: return { kind: "socket-read", fd: input.u32(), length: input.u32() };
    case 40: return { kind: "socket-write", fd: input.u32(), bytes: input.bytes() };
    case 41: { const fd = input.u32(); const direction = input.u8(); return { kind: "socket-shutdown", fd, direction: direction === 0 ? "read" : direction === 1 ? "write" : direction === 2 ? "both" : undefined }; }
    case 42: return { kind: "socket-close", fd: input.u32() };
    case 43: return { kind: "socket-address", fd: input.u32() };
    case 45: { const fd = input.u32(); const enabled = input.u8(); return { kind: "socket-keepalive", fd, enabled: enabled === 0 ? false : enabled === 1 ? true : undefined, delaySeconds: input.u32() }; }
    case 44: { const fd = input.u32(); const enabled = input.u8(); return { kind: "socket-nodelay", fd, enabled: enabled === 0 ? false : enabled === 1 ? true : undefined }; }
    case 35: return { kind: "readdir-entries", path: input.string() };
    case 34: return { kind: "access", path: input.string(), mode: input.u8() };
    case 32: return { kind: "getcwd" };
    case 33: return { kind: "chdir", path: input.string() };
    case 31: return { kind: "check-dependencies", policy: input.bytes() };
    default: return fail("unknown assistance operation tag");
  }
}

export function decodeAssistanceEnvironment(value: unknown): Readonly<Record<string, string>> {
  const input = record(value, "task environment");
  if (Object.keys(input).length > 4096) fail("invalid environment count");
  let length = 4;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) fail("invalid environment key");
    const name = path(key); const text = path(value, true);
    length += 8 + encoder.encode(name).length + encoder.encode(text).length;
    if (length > ASSISTANCE_LIMITS.request - 61) fail("environment exceeds envelope limit");
    return [name, text];
  }));
}
export function readAssistanceEnvironment(input: AgentPayloadReader): Readonly<Record<string, string>> {
  const count = integer(input.u32(), "environment count", 0, 4096);
  const entries = Array.from({ length: count }, () => [input.string(), input.string()] as const);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) fail("duplicate environment key");
  return decodeAssistanceEnvironment(Object.fromEntries(entries));
}
export function writeAssistanceEnvironment(output: AgentPayloadWriter, env: Readonly<Record<string, string>>): void {
  const entries = Object.entries(env);
  output.u32(entries.length);
  for (const [key, value] of entries) output.string(key).string(value);
}
