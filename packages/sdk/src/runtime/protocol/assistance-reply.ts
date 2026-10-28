import { decodeWatchEvents, readWatchEvents, writeWatchEvents, type AssistanceWatchEvent } from "./assistance-watch.js";
import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { TextEncoder } from "../web-encoding.js";
import { decodeAssistanceSocketAddress, readAssistanceSocketAddress, writeAssistanceSocketAddress, sameSocketIp, type AssistanceSocketAddress, ASSISTANCE_LIMITS, decodeAssistanceIdentity, decodeAssistanceEnvironment, readAssistanceEnvironment, writeAssistanceEnvironment, type AssistanceIdentity, type AssistanceRequest, type AssistanceOperation } from "./assistance.js";

/** Includes the identity and all four bounded strings of a Linux error. */
export function assistanceReplyCapacity(operation: AssistanceOperation): number {
  switch (operation.kind) {
    case "watch-add": case "watch-remove": case "watch-read": case "fork": return 20 * 1024;
    case "start": return ASSISTANCE_LIMITS.request;
    case "socket-read": case "read": return Math.max(20 * 1024, operation.length + 128);
    case "readdir": case "readdir-entries": return ASSISTANCE_LIMITS.chunk + 128;
    case "socket-listen": case "socket-connect-local": case "socket-accept": case "socket-write": case "socket-shutdown": case "socket-close": case "socket-address": case "socket-nodelay": case "socket-keepalive":
    case "link": case "symlink": case "write": case "signal": case "spawn":
    case "stdin": case "close-stdin": case "stop": case "terminal-ack":
    case "open": case "close": case "fstat": case "fsync": case "fdatasync":
    case "stat": case "lstat": case "readlink": case "realpath": case "unlink":
    case "rmdir": case "mkdir": case "chmod": case "fchmod": case "truncate":
    case "ftruncate": case "rename": case "ack": case "access": case "getcwd": case "chdir": case "check-dependencies": return 20 * 1024;
  }
}

export interface AssistanceStat {
  /** null identifies legacy v4 metadata; it is not a Linux rdev/birth value. */
  readonly details: { readonly rdev: bigint; readonly birthtimeNs: bigint | null } | null;
  readonly dev: bigint; readonly ino: bigint; readonly nlink: bigint;
  readonly size: bigint; readonly blocks: bigint;
  readonly mode: number; readonly uid: number; readonly gid: number; readonly blksize: number;
  readonly atimeNs: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint;
}

export type AssistanceResult =
  | { readonly kind: "watch-opened"; readonly watch: number }
  | { readonly kind: "watch-events"; readonly events: readonly AssistanceWatchEvent[] }
  | { readonly kind: "socket"; readonly fd: number; readonly local: AssistanceSocketAddress; readonly peer: AssistanceSocketAddress | null }
  | { readonly kind: "unit" }
  | { readonly kind: "terminal"; readonly sequence: number; readonly errno: number }
  | { readonly kind: "started"; readonly cwd: string; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: "opened"; readonly fd: number }
  | { readonly kind: "data"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "written"; readonly count: number }
  | { readonly kind: "stat"; readonly stat: AssistanceStat }
  | { readonly kind: "names"; readonly names: readonly string[] }
  | { readonly kind: "entries"; readonly entries: readonly { readonly name: string; readonly mode: number }[] }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "spawned"; readonly child: number; readonly pid: number }
  | { readonly kind: "error"; readonly errno: number; readonly code: string; readonly syscall: string; readonly path: string | null; readonly destination: string | null };

export interface AssistanceReply extends AssistanceIdentity { readonly result: AssistanceResult }

const encoder = new TextEncoder();
function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
function id(value: unknown): number { return integer(value, "assistance handle", 1, 0xffff_ffff); }
function text(value: unknown, empty = false): string {
  const result = string(value, "assistance reply string");
  if ((!empty && result.length === 0) || result.includes("\0") || encoder.encode(result).length >= 4096) fail("invalid assistance reply string");
  return result;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value, true); }
function word(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) fail("invalid stat unsigned integer");
  return value;
}
function signed(value: unknown): bigint {
  if (typeof value !== "bigint" || value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) fail("invalid stat timestamp");
  return value;
}
function stat(value: unknown): AssistanceStat {
  const input = record(value, "assistance stat");
  exactKeys(input, ["details", "dev", "ino", "nlink", "size", "blocks", "mode", "uid", "gid", "blksize", "atimeNs", "mtimeNs", "ctimeNs"]);
  return {
    details: statDetails(input["details"]),
    dev: word(input["dev"]), ino: word(input["ino"]), nlink: word(input["nlink"]), size: word(input["size"]), blocks: word(input["blocks"]),
    mode: integer(input["mode"], "stat mode", 0, 0xffff), uid: integer(input["uid"], "stat uid", 0, 0xffff_ffff),
    gid: integer(input["gid"], "stat gid", 0, 0xffff_ffff), blksize: integer(input["blksize"], "stat block size", 0, 0xffff_ffff),
    atimeNs: signed(input["atimeNs"]), mtimeNs: signed(input["mtimeNs"]), ctimeNs: signed(input["ctimeNs"]),
  };
}

function statDetails(value: unknown): AssistanceStat["details"] {
  if (value === null) return null;
  const input = record(value, "Linux stat details");
  exactKeys(input, ["rdev", "birthtimeNs"]);
  return { rdev: word(input["rdev"]), birthtimeNs: input["birthtimeNs"] === null ? null : signed(input["birthtimeNs"]) };
}

function result(value: unknown): AssistanceResult {
  const input = record(value, "assistance result");
  const kind = input["kind"];
  switch (kind) {
    case "watch-opened": exactKeys(input, ["kind", "watch"]); return { kind, watch: id(input["watch"]) };
    case "watch-events": exactKeys(input, ["kind", "events"]); return { kind, events: decodeWatchEvents(input["events"]) };
    case "socket": exactKeys(input, ["kind", "fd", "local", "peer"]); return { kind, fd: id(input["fd"]), local: decodeAssistanceSocketAddress(input["local"]), peer: input["peer"] === null ? null : decodeAssistanceSocketAddress(input["peer"]) };
    case "unit": exactKeys(input, ["kind"]); return { kind };
    case "terminal": exactKeys(input, ["kind", "sequence", "errno"]);
      return { kind, sequence: id(input["sequence"]), errno: integer(input["errno"], "terminal errno", 1, 4095) };
    case "started": exactKeys(input, ["kind", "cwd", "env"]); return { kind, cwd: text(input["cwd"]), env: decodeAssistanceEnvironment(input["env"]) };
    case "opened": exactKeys(input, ["kind", "fd"]); return { kind, fd: id(input["fd"]) };
    case "written": exactKeys(input, ["kind", "count"]); return { kind, count: integer(input["count"], "written count", 0, ASSISTANCE_LIMITS.chunk) };
    case "stat": exactKeys(input, ["kind", "stat"]); return { kind, stat: stat(input["stat"]) };
    case "path": exactKeys(input, ["kind", "path"]); return { kind, path: text(input["path"]) };
    case "spawned": exactKeys(input, ["kind", "child", "pid"]); return { kind, child: id(input["child"]), pid: integer(input["pid"], "child pid", 1, 0x7fff_ffff) };
    case "data": {
      exactKeys(input, ["kind", "bytes"]);
      const bytes = input["bytes"];
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > ASSISTANCE_LIMITS.chunk) fail("invalid assistance data");
      return { kind, bytes: new Uint8Array(bytes) };
    }
    case "names": {
      exactKeys(input, ["kind", "names"]);
      const names: unknown = input["names"];
      if (!Array.isArray(names) || names.length > ASSISTANCE_LIMITS.chunk / 5) fail("invalid directory listing");
      let length = 4;
      return { kind, names: names.map((value: unknown) => {
        const name = text(value);
        length += 4 + encoder.encode(name).length;
        if (name === "." || name === ".." || name.includes("/") || length > ASSISTANCE_LIMITS.chunk) fail("invalid directory entry");
        return name;
      }) };
    }
    case "entries": {
      exactKeys(input, ["kind", "entries"]);
      const entries: unknown = input["entries"];
      if (!Array.isArray(entries) || entries.length > Math.floor(ASSISTANCE_LIMITS.chunk / 9)) fail("invalid typed directory listing");
      let length = 4;
      return { kind, entries: entries.map((value: unknown) => {
        const entry = record(value, "directory entry");
        exactKeys(entry, ["name", "mode"]);
        const name = text(entry["name"]);
        const mode = integer(entry["mode"], "directory entry mode", 0, 0xffff);
        length += 8 + encoder.encode(name).length;
        if (name === "." || name === ".." || name.includes("/") || length > ASSISTANCE_LIMITS.chunk
          || ![0o010000, 0o020000, 0o040000, 0o060000, 0o100000, 0o120000, 0o140000].includes(mode)) fail("invalid typed directory entry");
        return { name, mode };
      }) };
    }
    case "error": {
      exactKeys(input, ["kind", "errno", "code", "syscall", "path", "destination"]);
      const code = text(input["code"]); const syscall = text(input["syscall"]);
      if (!/^E[A-Z0-9]+$/u.test(code) || !/^[a-z][a-z0-9_-]*$/u.test(syscall)) fail("invalid Linux error identity");
      return { kind, errno: integer(input["errno"], "Linux errno", 1, 4095), code, syscall, path: nullableText(input["path"]), destination: nullableText(input["destination"]) };
    }
    default: return fail("unknown assistance result");
  }
}

export function encodeAssistanceReply(value: unknown, version: unknown = 4): Uint8Array<ArrayBuffer> {
  if (version !== 4 && version !== 5 && version !== 6 && version !== 7) fail("Unsupported assistance reply version");
  const input = record(value, "assistance reply");
  exactKeys(input, ["session", "generation", "process", "sequence", "result"]);
  const identity = decodeAssistanceIdentity({ session: input["session"], generation: input["generation"], process: input["process"], sequence: input["sequence"] });
  const decoded = result(input["result"]);
  const out = new AgentPayloadWriter(ASSISTANCE_LIMITS.request).string(identity.session).u32(identity.generation).u32(identity.process).u32(identity.sequence);
  switch (decoded.kind) {
    case "watch-opened":
      if (version !== 7) fail("Watch replies require v7");
      out.u8(13).u32(decoded.watch); break;
    case "watch-events":
      if (version !== 7) fail("Watch replies require v7");
      out.u8(14); writeWatchEvents(out, decoded.events); break;
    case "socket":
      if (version !== 7) fail("Socket replies require v7");
      out.u8(12).u32(decoded.fd); writeAssistanceSocketAddress(out, decoded.local);
      out.u8(decoded.peer === null ? 0 : 1); if (decoded.peer !== null) writeAssistanceSocketAddress(out, decoded.peer);
      break;
    case "unit": out.u8(0); break;
    case "terminal":
      if (version !== 5 && version !== 6 && version !== 7) fail("Terminal receipts require v5");
      out.u8(10).u32(decoded.sequence).u32(decoded.errno); break;
    case "started": out.u8(1).string(decoded.cwd); writeAssistanceEnvironment(out, decoded.env); break;
    case "opened": out.u8(2).u32(decoded.fd); break;
    case "data": out.u8(3).bytes(decoded.bytes); break;
    case "written": out.u8(4).u32(decoded.count); break;
    case "stat": {
      const s = decoded.stat;
      out.u8(5).u64(s.dev).u64(s.ino).u64(s.nlink).u64(s.size).u64(s.blocks)
        .u32(s.mode).u32(s.uid).u32(s.gid).u32(s.blksize).i64(s.atimeNs).i64(s.mtimeNs).i64(s.ctimeNs);
      if (version >= 5) {
        if (s.details === null) fail("v5 requires Linux stat metadata");
        out.u64(s.details.rdev).u8(s.details.birthtimeNs === null ? 0 : 1);
        if (s.details.birthtimeNs !== null) out.i64(s.details.birthtimeNs);
      }
      break;
    }
    case "names": out.u8(6).u32(decoded.names.length); for (const name of decoded.names) out.string(name); break;
    case "entries":
      if (version !== 7) fail("Directory entry metadata requires v7");
      out.u8(11).u32(decoded.entries.length);
      for (const entry of decoded.entries) out.string(entry.name).u32(entry.mode);
      break;
    case "path": out.u8(7).string(decoded.path); break;
    case "spawned": out.u8(8).u32(decoded.child).u32(decoded.pid); break;
    case "error":
      out.u8(9).u32(decoded.errno).string(decoded.code).string(decoded.syscall);
      for (const path of [decoded.path, decoded.destination]) { out.u8(path === null ? 0 : 1); if (path !== null) out.string(path); }
      break;
  }
  return out.finish();
}

export function decodeAssistanceReply(bytes: Uint8Array, version: unknown = 4): AssistanceReply {
  if (version !== 4 && version !== 5 && version !== 6 && version !== 7) fail("Unsupported assistance reply version");
  if (bytes.byteLength > ASSISTANCE_LIMITS.request) fail("assistance reply exceeds limit");
  const input = new AgentPayloadReader(new Uint8Array(bytes));
  const identity = decodeAssistanceIdentity({ session: input.string(), generation: input.u32(), process: input.u32(), sequence: input.u32() });
  const decoded = result(readResult(input, version));
  input.finish();
  return { ...identity, result: decoded };
}

function readNullable(input: AgentPayloadReader): string | null {
  switch (input.u8()) { case 0: return null; case 1: return input.string(); default: return fail("invalid nullable path tag"); }
}
function readStatDetails(input: AgentPayloadReader): AssistanceStat["details"] {
  const rdev = input.u64();
  switch (input.u8()) {
    case 0: return { rdev, birthtimeNs: null };
    case 1: return { rdev, birthtimeNs: input.i64() };
    default: return fail("Invalid birth time availability");
  }
}
function readResult(input: AgentPayloadReader, version: 4 | 5 | 6 | 7): unknown {
  switch (input.u8()) {
    case 13:
      if (version !== 7) fail("Watch replies require v7");
      return { kind: "watch-opened", watch: input.u32() };
    case 14:
      if (version !== 7) fail("Watch replies require v7");
      return { kind: "watch-events", events: readWatchEvents(input) };
    case 0: return { kind: "unit" };
    case 1: return { kind: "started", cwd: input.string(), env: readAssistanceEnvironment(input) };
    case 2: return { kind: "opened", fd: input.u32() };
    case 3: return { kind: "data", bytes: input.bytes() };
    case 4: return { kind: "written", count: input.u32() };
    case 5: return { kind: "stat", stat: {
      dev: input.u64(), ino: input.u64(), nlink: input.u64(), size: input.u64(), blocks: input.u64(),
      mode: input.u32(), uid: input.u32(), gid: input.u32(), blksize: input.u32(),
      atimeNs: input.i64(), mtimeNs: input.i64(), ctimeNs: input.i64(),
      details: version >= 5 ? readStatDetails(input) : null,
    } };
    case 6: return { kind: "names", names: Array.from({ length: integer(input.u32(), "directory count", 0, Math.floor(ASSISTANCE_LIMITS.chunk / 5)) }, () => input.string()) };
    case 12: {
      if (version !== 7) fail("Socket replies require v7");
      const fd = input.u32(); const local = readAssistanceSocketAddress(input); const peer = input.u8();
      if (peer !== 0 && peer !== 1) fail("Invalid socket peer tag");
      return { kind: "socket", fd, local, peer: peer === 0 ? null : readAssistanceSocketAddress(input) };
    }
    case 11:
      if (version !== 7) fail("Directory entry metadata requires v7");
      return { kind: "entries", entries: Array.from({ length: integer(input.u32(), "directory count", 0, Math.floor(ASSISTANCE_LIMITS.chunk / 9)) }, () => ({ name: input.string(), mode: input.u32() })) };
    case 7: return { kind: "path", path: input.string() };
    case 8: return { kind: "spawned", child: input.u32(), pid: input.u32() };
    case 9: return { kind: "error", errno: input.u32(), code: input.string(), syscall: input.string(), path: readNullable(input), destination: readNullable(input) };
    case 10:
      if (version !== 5 && version !== 6 && version !== 7) fail("Terminal receipts require v5");
      return { kind: "terminal", sequence: input.u32(), errno: input.u32() };
    default: return fail("unknown assistance reply tag");
  }
}

/** Correlation and shape checks precede every dispatch to a process callback. */
export function matchAssistanceReply(request: AssistanceRequest, reply: AssistanceReply): AssistanceResult {
  if (request.session !== reply.session || request.generation !== reply.generation || request.process !== reply.process || request.sequence !== reply.sequence) fail("stale assistance reply identity");
  const value = reply.result;
  if (value.kind === "error") return value;
  const operation = request.operation;
  switch (operation.kind) {
    case "watch-add": if (value.kind === "watch-opened") return value; break;
    case "watch-remove": if (value.kind === "unit") return value; break;
    case "watch-read": if (value.kind === "watch-events") return value; break;
    case "socket-read": if (value.kind === "data" && value.bytes.length <= operation.length) return value; break;
    case "socket-write": if (value.kind === "written" && value.count <= operation.bytes.length) return value; break;
    case "socket-close": case "socket-shutdown": case "socket-nodelay": case "socket-keepalive": if (value.kind === "unit") return value; break;
    case "socket-listen": if (value.kind === "socket" && value.peer === null && sameSocketIp(value.local.address, operation.address.address) && (operation.address.port === 0 || operation.address.port === value.local.port)) return value; break;
    case "socket-connect-local": if (value.kind === "socket" && value.peer !== null && sameSocketIp(value.peer.address, operation.address.address) && value.peer.port === operation.address.port) return value; break;
    case "socket-accept": if (value.kind === "socket" && value.peer !== null) return value; break;
    case "socket-address": if (value.kind === "socket" && value.fd === operation.fd) return value; break;
    case "start": if (value.kind === "started") return value; break;
    case "open": if (value.kind === "opened") return value; break;
    case "read": if (value.kind === "data" && value.bytes.length <= operation.length) return value; break;
    case "check-dependencies": if (value.kind === "data" && (value.bytes.length === 0 || value.bytes.length === 64)) return value; break;
    case "write": case "stdin": if (value.kind === "written" && value.count <= operation.bytes.length) return value; break;
    case "stat": case "lstat": case "fstat": if (value.kind === "stat") return value; break;
    case "readdir": if (value.kind === "names") return value; break;
    case "readdir-entries": if (value.kind === "entries") return value; break;
    case "readlink": case "realpath": if (value.kind === "path") return value; break;
    case "getcwd": if (value.kind === "path" && value.path.startsWith("/")) return value; break;
    case "spawn": case "fork": if (value.kind === "spawned") return value; break;
    case "stop": if (value.kind === "unit" || value.kind === "terminal") return value; break;
    case "access": case "chdir": case "close": case "fsync": case "fdatasync": case "unlink": case "rmdir": case "mkdir": case "chmod": case "fchmod": case "truncate": case "ftruncate": case "rename": case "link": case "symlink": case "close-stdin": case "signal": case "ack": case "terminal-ack":
      if (value.kind === "unit") return value; break;
  }
  return fail("assistance reply does not match operation");
}
