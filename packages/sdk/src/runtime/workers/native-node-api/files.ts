import type { LinuxFileStat } from "../../../js-process-types.js";
import { VMError } from "../../errors.js";
import { descriptor, LinuxError, type LinuxOperation, type LinuxResult, noValue, operation, protocol, value, Writer } from "../../js-process/codec.js";
import { files as operations } from "../../js-process/file-operations.js";
import { decodeAddress, encodeAddress } from "../../js-process/sockets.js";
import type { LinuxClient } from "../../js-process/transport.js";
import type { AssistanceOperation, AssistanceSocketAddress } from "../../protocol/assistance.js";
import type { AssistanceResult, AssistanceStat } from "../../protocol/assistance-reply.js";
import { NativeFileWatches } from "./watches.js";
import { nodeResult } from "../assistance/node-file-operations.js";
import type { ModulePathInfo } from "../assistance/module-files.js";
import { linuxErrnoCode } from "../../linux-errno.js";

// Mode10 is a private adapter capability and never enters the system-agent wire.
const openFlags = [0, 2, 0o1101, 0o1102, 0o1301, 0o1302, 0o2101, 0o2102, 0o2301, 0o2302, 0o101];
type Request = Generator<LinuxOperation<LinuxResult>, AssistanceResult, LinuxResult>;

export function nativeModulePathInfo(client: Pick<LinuxClient, "sync">, path: string): ModulePathInfo {
  try { const info = client.sync(operations.pathInfo(path)); return { path: info.path, mode: info.stat.mode }; }
  catch (error) { return nodeResult(nodeError(error, { kind: "stat", path })); }
}

/** Both call styles execute the same bounded operation sequence. Rust owns Linux semantics. */
export function createNativeFileService(client: Pick<LinuxClient, "call" | "sync">) {
  const watches = new NativeFileWatches(client);
  return {
    callSync(input: AssistanceOperation): AssistanceResult {
      const request = fileRequest(input, watches); let step = request.next();
      while (step.done !== true) {
        let result: LinuxResult;
        try { result = client.sync(step.value); } catch (error) { step = request.throw(error); continue; }
        step = request.next(result);
      }
      return step.value;
    },
    async call(input: AssistanceOperation, signal?: AbortSignal): Promise<AssistanceResult> {
      const request = fileRequest(input, watches); let step = request.next();
      while (step.done !== true) {
        let result: LinuxResult;
        // Descriptor cleanup must finish even after the operation was cancelled.
        try { result = await client.call(step.value, step.value.number === 3 ? undefined : signal); } catch (error) { step = request.throw(error); continue; }
        step = request.next(result);
      }
      return step.value;
    },
  };
}


function* perform<T>(request: LinuxOperation<T>): Generator<LinuxOperation<LinuxResult>, T, LinuxResult> {
  const result = yield { ...request, decode: value => value };
  return request.decode(result);
}
function stat(value: LinuxFileStat & { readonly rdev: bigint; readonly blockSize: bigint; readonly blocks: bigint }): AssistanceStat {
  return { details: { rdev: value.rdev, birthtimeNs: null }, dev: value.device, ino: value.inode, nlink: value.links, mode: value.mode, uid: value.uid, gid: value.gid, size: value.size, blocks: value.blocks, blksize: Number(value.blockSize), atimeNs: value.accessedNs, mtimeNs: value.modifiedNs, ctimeNs: value.changedNs };
}
function* fileRequest(input: AssistanceOperation, watches: NativeFileWatches): Request {
  try {
    switch (input.kind) {
      case "watch-add": return watches.add(input.path);
      case "watch-remove": return watches.remove(input.watch);
      case "watch-read": return yield* perform(watches.read());
      case "open": { const flags = openFlags[input.flags]; if (flags === undefined) protocol("Invalid Node open flags"); return { kind: "opened", fd: yield* perform(operations.open(input.path, flags, input.mode)) }; }
      case "close": case "socket-close": yield* perform(operations.close(input.fd)); break;
      case "read": case "socket-read": {
        const offset = input.kind === "read" ? input.offset : null;
        const request = offset === null ? operations.read(input.fd, input.length) : operation(17, new Writer().u64(input.fd).u64(input.length).u64(offset), result => operations.read(input.fd, input.length).decode(result));
        return { kind: "data", bytes: new Uint8Array(yield* perform(request)) };
      }
      case "write": case "socket-write": {
        const offset = input.kind === "write" ? input.offset : null;
        const request = offset === null ? operations.write(input.fd, input.bytes) : operation(18, new Writer().u64(input.fd).blob(input.bytes).u64(offset), result => operations.write(input.fd, input.bytes).decode(result));
        return { kind: "written", count: yield* perform(request) };
      }
      case "stat": case "lstat": return { kind: "stat", stat: stat(yield* perform(operations.stat(input.path, input.kind === "stat"))) };
      case "fstat": return { kind: "stat", stat: stat(yield* perform(operations.fstat(input.fd))) };
      case "realpath": return { kind: "path", path: yield* perform(operations.realpath(input.path)) };
      case "readdir": case "readdir-entries": {
        const fd = yield* perform(operations.open(input.path, 0o200000));
        const entries = [];
        try { for (;;) { const next = yield* perform(operations.getdents(fd)); if (next.length === 0) break; entries.push(...next.filter(entry => entry.name !== "." && entry.name !== "..")); } }
        finally { yield* perform(operations.close(fd)); }
        return input.kind === "readdir" ? { kind: "names", names: entries.map(entry => entry.name) } : { kind: "entries", entries: entries.map(entry => ({ name: entry.name, mode: entry.type << 12 })) };
      }
      case "mkdir": yield* perform(operations.mkdir(input.path, input.mode)); break;
      case "rename": yield* perform(operations.rename(input.path, input.destination)); break;
      case "unlink": case "rmdir": yield* perform(operations.unlink(input.path, input.kind === "rmdir")); break;
      case "fsync": case "fdatasync": yield* perform(operation(input.kind === "fsync" ? 74 : 75, new Writer().u64(input.fd), noValue)); break;
      case "getcwd": return { kind: "path", path: yield* perform(operation(79, new Writer(), result => { if (result.bytes.at(-1) !== 0) protocol("Invalid Linux cwd"); return new TextDecoder().decode(result.bytes.subarray(0, -1)); })) };
      case "chdir": yield* perform(operation(80, new Writer().path(input.path), noValue)); break;
      case "access": yield* perform(operation(21, new Writer().path(input.path).u64(input.mode), noValue)); break;
      case "readlink": return { kind: "path", path: yield* perform(operation(89, new Writer().path(input.path), result => new TextDecoder().decode(result.bytes))) };
      case "chmod": yield* perform(operation(90, new Writer().path(input.path).u64(input.mode), noValue)); break;
      case "fchmod": yield* perform(operation(91, new Writer().u64(input.fd).u64(input.mode), noValue)); break;
      case "truncate": yield* perform(operation(76, new Writer().path(input.path).u64(input.length), noValue)); break;
      case "ftruncate": yield* perform(operation(77, new Writer().u64(input.fd).u64(input.length), noValue)); break;
      case "link": yield* perform(operation(86, new Writer().path(input.path).path(input.destination), noValue)); break;
      case "symlink": yield* perform(operation(88, new Writer().path(input.target).path(input.path), noValue)); break;
      case "socket-listen": case "socket-connect-local": {
        const address = { family: input.address.address.includes(":") ? "ipv6" as const : "ipv4" as const, ...input.address };
        const fd = yield* perform(operation(41, new Writer().u32(address.family === "ipv4" ? 2 : 10), result => descriptor(value(result))));
        try {
          yield* perform(operation(input.kind === "socket-listen" ? 49 : 42, new Writer().u64(fd).blob(encodeAddress(address)), noValue));
          if (input.kind === "socket-listen") yield* perform(operation(50, new Writer().u64(fd).u32(input.backlog), noValue));
          return yield* socketResult(fd, input.kind !== "socket-listen");
        } catch (error) { yield* perform(operations.close(fd)); throw error; }
      }
      case "socket-accept": { const fd = yield* perform(operation(43, new Writer().u64(input.fd), result => descriptor(value(result)))); return yield* socketResult(fd, true); }
      case "socket-address": return yield* socketResult(input.fd, "optional");
      case "socket-shutdown": yield* perform(operation(48, new Writer().u64(input.fd).u8(input.direction === "read" ? 0 : input.direction === "write" ? 1 : 2), noValue)); break;
      case "socket-nodelay": yield* perform(operation(54, new Writer().u64(input.fd).u32(6).u32(1).u32(Number(input.enabled)), noValue)); break;
      case "socket-keepalive":
        yield* perform(operation(54, new Writer().u64(input.fd).u32(1).u32(9).u32(Number(input.enabled)), noValue));
        if (input.enabled && input.delaySeconds !== 0) yield* perform(operation(54, new Writer().u64(input.fd).u32(6).u32(4).u32(input.delaySeconds), noValue));
        break;
      case "fork": case "start": case "stop": case "check-dependencies": case "terminal-ack": case "spawn": case "stdin": case "close-stdin": case "signal": case "ack":
        throw new VMError("FEATURE_NOT_AVAILABLE", `Node operation is not qualified: ${input.kind}`);
    }
    return { kind: "unit" };
  } catch (error) { return nodeError(error, input); }
}
function* socketResult(fd: number, peer: boolean | "optional"): Request {
  const address = (peer: boolean) => operation(peer ? 52 : 51, new Writer().u64(fd), result => {
    if (result.bytes.byteLength !== 132) protocol("Invalid Linux socket address record");
    const length = new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(128, true);
    if (length > 128) protocol("Oversized Linux socket address");
    const address = decodeAddress(result.bytes.subarray(0, length));
    if (address.family === "unix") protocol("TCP builtin returned a Unix address");
    return { address: address.address, port: address.port } satisfies AssistanceSocketAddress;
  });
  const local = yield* perform(address(false));
  let remote: AssistanceSocketAddress | null = null;
  if (peer !== false) {
    try { remote = yield* perform(address(true)); }
    catch (error) { if (peer !== "optional" || !(error instanceof LinuxError) || error.errno !== 107) throw error; }
  }
  return { kind: "socket", fd, local, peer: remote };
}
export function nodeError(error: unknown, input: AssistanceOperation): Extract<AssistanceResult, { kind: "error" }> {
  if (!(error instanceof LinuxError)) throw error;
  const code = linuxErrnoCode(error.errno);
  return { kind: "error", errno: error.errno, code, syscall: input.kind, path: "path" in input ? input.path : null, destination: "destination" in input ? input.destination : null };
}
