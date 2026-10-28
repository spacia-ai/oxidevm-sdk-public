import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS, type AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { fileURLToPath } from "./node-url.js";

/** One Linux operation program is driven by either the synchronous mailbox or
 * asynchronous completion. Both forms retain identical validation and cleanup. */
export type FileOperation<Result> = Generator<AssistanceOperation, Result, AssistanceResult>;
export const fileAccessConstants = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4 });
const flags = ["r", "r+", "w", "w+", "wx", "wx+", "a", "a+", "ax", "ax+"];

export function createFileOperations(cwd: () => string, asynchronous = false, copyOpenMode?: 10) {
  function* perform(operation: AssistanceOperation): FileOperation<AssistanceResult> {
    if (("path" in operation && operation.path === "") || ("destination" in operation && operation.destination === "")) {
      const syscall = (operation.kind === "readdir" || operation.kind === "readdir-entries") ? "scandir" : operation.kind === "truncate" ? "open" : operation.kind;
      throw Object.assign(new Error(`ENOENT: ${syscall}`), { errno: -2, code: "ENOENT", syscall,
        ...("path" in operation ? { path: operation.path } : {}),
        ...("destination" in operation ? { dest: operation.destination } : {}) });
    }
    const result = yield operation;
    return nodeResult(result.kind === "error" && (operation.kind === "readdir" || operation.kind === "readdir-entries") ? { ...result, syscall: "scandir" } : result);
  }
  function* unit(operation: AssistanceOperation): FileOperation<void> {
    if ((yield* perform(operation)).kind !== "unit") throw mismatch();
  }
  function path(value: unknown): string {
    const decoded = value instanceof URL ? fileURLToPath(value) : value;
    if (typeof decoded !== "string" || decoded.includes("\0")) throw new TypeError("Only UTF-8 string and file URL paths are supported");
    // The authenticated helper owns cwd resolution. Preserve caller spelling
    // here so Linux failures retain Node's path/destination fields.
    return decoded;
  }
  function* open(value: unknown, flag: unknown = "r", mode: unknown = 0o666): FileOperation<number> {
    if (typeof flag !== "string" || !flags.includes(flag)) throw new TypeError("Unsupported open flags");
    const result = yield* perform({ kind: "open", path: path(value), flags: flags.indexOf(flag), mode: number(mode, 0o7777) });
    if (result.kind !== "opened") throw mismatch();
    return result.fd;
  }
  function* close(fd: unknown): FileOperation<void> { yield* unit({ kind: "close", fd: descriptor(fd) }); }
  function* read(fd: unknown, buffer: unknown, offset: unknown, length: unknown, position: unknown = null): FileOperation<number> {
    const target = binary(buffer);
    const begin = number(offset, target.length);
    const count = Math.min(number(length, target.length - begin), ASSISTANCE_LIMITS.chunk);
    const result = yield* perform({ kind: "read", fd: descriptor(fd), length: count, offset: positionValue(position) });
    if (result.kind !== "data" || result.bytes.length > count) throw mismatch();
    target.set(result.bytes, begin);
    return result.bytes.length;
  }
  function* write(fd: unknown, buffer: unknown, offset?: unknown, length?: unknown, position: unknown = null): FileOperation<number> {
    const text = typeof buffer === "string";
    const source = text ? Buffer.from(buffer, bufferEncoding(length, "utf8") ?? "utf8") : binary(buffer);
    const begin = text ? 0 : number(offset ?? 0, source.length);
    const count = text ? source.length : number(length ?? source.length - begin, source.length - begin);
    let cursor = positionValue(text ? offset ?? null : position), written = 0;
    do {
      const bytes = new Uint8Array(source.subarray(begin + written, begin + Math.min(count, written + ASSISTANCE_LIMITS.chunk)));
      const result = yield* perform({ kind: "write", fd: descriptor(fd), bytes, offset: cursor });
      if (result.kind !== "written" || result.count > bytes.length) throw mismatch();
      written += result.count; if (cursor !== null) cursor += BigInt(result.count);
      if (result.count < bytes.length) break;
    } while (written < count);
    return written;
  }
  function* withFile<Result>(value: unknown, flag: string, body: (fd: number) => FileOperation<Result>, mode = 0o666): FileOperation<Result> {
    // Whole-file APIs accepting a descriptor retain caller-owned offset/lifetime.
    const owned = typeof value !== "number";
    const fd = owned ? yield* open(value, flag, mode) : descriptor(value);
    return owned ? yield* closeAfter(fd, body) : yield* body(fd);
  }
  function* closeAfter<Result>(fd: number, body: (fd: number) => FileOperation<Result>): FileOperation<Result> {
    let result: Result;
    try { result = yield* body(fd); }
    catch (error) {
      try { yield* close(fd); } catch { /* Preserve the original operation failure. */ }
      throw error;
    }
    yield* close(fd);
    return result;
  }
  function* readFile(value: unknown, options?: unknown): FileOperation<Buffer | string> {
    const selected = contentOptions(options, "r");
    const bytes = yield* withFile(value, selected.flag, function* (fd): FileOperation<Buffer> {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const chunk = new Uint8Array(ASSISTANCE_LIMITS.chunk);
        const count = yield* read(fd, chunk, 0, chunk.length);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        total += count;
      }
      return Buffer.concat(chunks, total);
    });
    return selected.encoding === null ? bytes : bytes.toString(selected.encoding);
  }
  function* writeFile(value: unknown, data: unknown, options?: unknown, flag: "w" | "a" = "w"): FileOperation<void> {
    const selected = contentOptions(options, flag);
    const bytes = typeof data === "string" ? Buffer.from(data, selected.encoding ?? "utf8") : binary(data);
    yield* withFile(value, selected.flag, function* (fd): FileOperation<void> {
      let offset = 0;
      while (offset < bytes.length) {
        const count = yield* write(fd, bytes, offset, bytes.length - offset);
        if (count === 0) throw Object.assign(new Error("EIO: write made no progress"), { errno: -5, code: "EIO", syscall: "write" });
        offset += count;
      }
      if (selected.flush) yield* unit({ kind: "fsync", fd });
    }, selected.mode);
  }
  function* pathResult(kind: "readlink" | "realpath", value: unknown, options?: unknown): FileOperation<string> {
    noOptions(options);
    const result = yield* perform({ kind, path: kind === "realpath" && value === "" ? cwd() : path(value) });
    if (result.kind !== "path") throw mismatch();
    return result.path;
  }
  function* stat(operation: AssistanceOperation, options?: unknown): FileOperation<FileStats | undefined> {
    let throwIfNoEntry = true;
    if (options !== undefined) {
      if (typeof options !== "object" || options === null || Object.keys(options).some(key => !["bigint", "throwIfNoEntry"].includes(key)) || Reflect.get(options, "bigint") === true) throw new TypeError("Unsupported filesystem options");
      const requested: unknown = Reflect.get(options, "throwIfNoEntry");
      if (requested !== undefined && typeof requested !== "boolean") throw new TypeError("Invalid throwIfNoEntry option");
      throwIfNoEntry = asynchronous || requested !== false;
    }
    let result: AssistanceResult;
    try { result = yield* perform(operation); }
    catch (error) {
      if (!throwIfNoEntry && typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
      throw error;
    }
    if (result.kind !== "stat") throw mismatch();
    return fileStats(result.stat);
  }
  function* copyFile(source: unknown, destination: unknown, flags: unknown = 0): FileOperation<void> {
    // shortcut: system assistance needs a negotiated nontruncating write-create mode before enabling copyFile.
    if (copyOpenMode === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "copyFile is not qualified by this file service");
    const from = path(source), to = path(destination), selected = number(flags, 7);
    if ((selected & 4) !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Forced copyFile reflinks are not qualified");
    try { yield* withFile(from, "r", function* (input): FileOperation<void> {
      const source = yield* perform({ kind: "fstat", fd: input });
      if (source.kind !== "stat") throw mismatch();
      if ((source.stat.mode & 0o170000) === 0o040000) throw Object.assign(new Error("EISDIR: copyfile"), { code: "EISDIR", errno: -21, syscall: "copyfile", path: from, dest: to });
      const opened = yield* perform({ kind: "open", path: to, flags: (selected & 1) !== 0 ? 4 : copyOpenMode, mode: source.stat.mode & 0o777 });
      if (opened.kind !== "opened") throw mismatch();
      const destination = { mutated: false };
      try {
        yield* closeAfter(opened.fd, function* (output): FileOperation<void> {
          const target = yield* perform({ kind: "fstat", fd: output });
          if (target.kind !== "stat") throw mismatch();
          if (source.stat.dev === target.stat.dev && source.stat.ino === target.stat.ino) return;
          yield* unit({ kind: "ftruncate", fd: output, length: 0n }); destination.mutated = true;
          let remaining = source.stat.size;
          while (remaining > 0n) {
            const count = Number(remaining < BigInt(ASSISTANCE_LIMITS.chunk) ? remaining : BigInt(ASSISTANCE_LIMITS.chunk));
            const read = yield* perform({ kind: "read", fd: input, length: count, offset: null });
            if (read.kind !== "data" || read.bytes.length > count) throw mismatch();
            if (read.bytes.length === 0) break;
            for (let offset = 0; offset < read.bytes.length;) {
              const bytes = read.bytes.subarray(offset), written = yield* perform({ kind: "write", fd: output, bytes, offset: null });
              if (written.kind !== "written" || written.count > bytes.length) throw mismatch();
              if (written.count === 0) throw Object.assign(new Error("EIO: copyfile made no progress"), { code: "EIO", errno: -5, syscall: "copyfile", path: from, dest: to });
              offset += written.count;
            }
            remaining -= BigInt(read.bytes.length);
          }
          yield* unit({ kind: "fchmod", fd: output, mode: source.stat.mode & 0o777 });
        });
      } catch (error) {
        if (destination.mutated) { try { yield* unit({ kind: "unlink", path: to }); } catch { /* Preserve the copy failure. */ } }
        throw error;
      }
    }); } catch (error) {
      if (error instanceof Error && "errno" in error && typeof error.errno === "number" && "code" in error && typeof error.code === "string") {
        Object.assign(error, { message: `${error.code}: copyfile '${from}' -> '${to}'`, syscall: "copyfile", path: from, dest: to });
      }
      throw error;
    }
  }
  function* rm(value: unknown, options: unknown = {}): FileOperation<void> {
    const requested = path(value);
    if (typeof options !== "object" || options === null || Array.isArray(options) || Object.keys(options).some(key => !["recursive", "force", "maxRetries", "retryDelay"].includes(key))) throw new TypeError("Unsupported rm options");
    const option = (key: string, fallback: unknown): unknown => { const value: unknown = Reflect.get(options, key); return value === undefined ? fallback : value; };
    const recursive = option("recursive", false), force = option("force", false);
    if (typeof recursive !== "boolean" || typeof force !== "boolean") throw new TypeError("rm recursive and force must be booleans");
    const retries = number(option("maxRetries", 0), 0xffff_ffff);
    number(option("retryDelay", 100), 0xffff_ffff);
    if (retries !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "rm retry options are not qualified");
    const pending = [{ path: requested, directory: false }];
    while (pending.length !== 0) {
      const current = pending.pop(); if (current === undefined) throw mismatch();
      try {
        if (current.directory) { yield* unit({ kind: "rmdir", path: current.path }); continue; }
        const info = yield* perform({ kind: "lstat", path: current.path });
        if (info.kind !== "stat") throw mismatch();
        if ((info.stat.mode & 0o170000) !== 0o040000) { yield* unit({ kind: "unlink", path: current.path }); continue; }
        if (!recursive) throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${current.path}`), { name: "SystemError", code: "ERR_FS_EISDIR", errno: 21, syscall: "rm", path: current.path, info: { code: "EISDIR", message: "is a directory", path: current.path, syscall: "rm", errno: 21 } });
        const entries = yield* perform({ kind: "readdir", path: current.path });
        if (entries.kind !== "names") throw mismatch();
        pending.push({ ...current, directory: true });
        for (const name of entries.names) {
          if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw mismatch();
          pending.push({ path: `${current.path.replace(/\/$/u, "")}/${name}`, directory: false });
        }
      } catch (error) {
        if (!force || typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
  }
  function* mkdir(value: unknown, options?: unknown): FileOperation<{ recursive: boolean; path: string | undefined }> {
    const requested = path(value);
    const { recursive, mode } = mkdirOptions(options);
    if (!recursive || requested === "") {
      yield* unit({ kind: "mkdir", path: requested, mode });
      return { recursive, path: undefined };
    }
    const pending = [requested];
    let first: string | undefined;
    while (pending.length !== 0) {
      const current = pending.pop();
      if (current === undefined) throw mismatch();
      if (current === "") nodeResult({ kind: "error", code: "ENOENT", errno: 2, syscall: "mkdir", path: asynchronous ? current : requested, destination: null });
      const result = yield { kind: "mkdir", path: current, mode };
      if (result.kind === "unit") { first ??= current; continue; }
      if (result.kind !== "error") throw mismatch();
      if (result.code === "ENOENT") {
        // Keep the original spelling: resolving '..' would skip real mkdirs.
        const slash = current.lastIndexOf("/");
        if (slash !== -1) { pending.push(current, current.slice(0, slash)); continue; }
        if (pending.length !== 0) continue;
      } else if (["EACCES", "ENOSPC", "ENOTDIR", "EPERM"].includes(result.code)) {
        nodeResult({ ...result, syscall: "mkdir", path: asynchronous ? current : requested });
      }
      const info = yield { kind: "stat", path: current };
      if (info.kind !== "stat" && info.kind !== "error") throw mismatch();
      const directory = info.kind === "stat" && (info.stat.mode & 0o170000) === 0o040000;
      if (directory) continue;
      // Node's asynchronous parent check reports ENOTDIR even when stat fails;
      // its synchronous form retains that stat failure. Verified against Node 24.
      let failure: Extract<AssistanceResult, { kind: "error" }>;
      if (result.code === "EEXIST" && pending.length !== 0 && (asynchronous || info.kind === "stat")) {
        failure = { ...result, code: "ENOTDIR", errno: 20 };
      } else if (info.kind === "error") failure = info;
      else failure = { ...result, code: "EEXIST", errno: 17 };
      nodeResult({ ...failure, syscall: "mkdir", path: asynchronous ? current : requested });
    }
    return { recursive, path: first };
  }
  return {
    access: checked((value: unknown, mode?: unknown) => unit({ kind: "access", path: path(value), mode: accessMode(mode) }), 1, 2),
    open: checked(open, 1, 3), close: checked(close, 1, 1),
    read: checked(read, 4, 5), write: checked(write, 2, 5),
    readFile: checked(readFile, 1, 2),
    writeFile: checked((value: unknown, data: unknown, encoding?: unknown) => writeFile(value, data, encoding), 2, 3),
    appendFile: checked((value: unknown, data: unknown, encoding?: unknown) => writeFile(value, data, encoding, "a"), 2, 3),
    stat: checked((value: unknown, options?: unknown) => stat({ kind: "stat", path: path(value) }, options), 1, 2),
    lstat: checked((value: unknown, options?: unknown) => stat({ kind: "lstat", path: path(value) }, options), 1, 2),
    fstat: checked((fd: unknown, options?: unknown) => stat({ kind: "fstat", fd: descriptor(fd) }, options), 1, 2),
    fsync: checked((fd: unknown) => unit({ kind: "fsync", fd: descriptor(fd) }), 1, 1),
    fdatasync: checked((fd: unknown) => unit({ kind: "fdatasync", fd: descriptor(fd) }), 1, 1),
    unlink: checked((value: unknown) => unit({ kind: "unlink", path: path(value) }), 1, 1),
    copyFile: checked(copyFile, 2, 3),
    rm: checked(rm, 1, 2),
    rmdir: checked(function* (value: unknown, options?: unknown): FileOperation<void> { noOptions(options); yield* unit({ kind: "rmdir", path: path(value) }); }, 1, 2),
    mkdir: checked(mkdir, 1, 2),
    chmod: checked((value: unknown, mode: unknown) => unit({ kind: "chmod", path: path(value), mode: number(mode, 0o7777) }), 2, 2),
    fchmod: checked((fd: unknown, mode: unknown) => unit({ kind: "fchmod", fd: descriptor(fd), mode: number(mode, 0o7777) }), 2, 2),
    truncate: checked((value: unknown, length: unknown = 0) => unit({ kind: "truncate", path: path(value), length: BigInt(number(length)) }), 1, 2),
    ftruncate: checked((fd: unknown, length: unknown = 0) => unit({ kind: "ftruncate", fd: descriptor(fd), length: BigInt(number(length)) }), 1, 2),
    rename: checked((value: unknown, destination: unknown) => unit({ kind: "rename", path: path(value), destination: path(destination) }), 2, 2),
    link: checked((value: unknown, destination: unknown) => unit({ kind: "link", path: path(value), destination: path(destination) }), 2, 2),
    symlink: checked(function* (target: unknown, value: unknown, type?: unknown): FileOperation<void> {
      noOptions(type);
      if (typeof target !== "string" || target.includes("\0")) throw new TypeError("Only UTF-8 string link targets are supported");
      const destination = path(value);
      if (target === "" || destination === "") throw Object.assign(new Error("ENOENT: symlink"), { errno: -2, code: "ENOENT", syscall: "symlink", path: target, dest: value });
      yield* unit({ kind: "symlink", path: destination, target });
    }, 2, 3),
    readlink: checked((value: unknown, options?: unknown) => pathResult("readlink", value, options), 1, 2),
    realpath: checked((value: unknown, options?: unknown) => pathResult("realpath", value, options), 1, 2),
    readdir: checked(function* (value: unknown, options?: unknown): FileOperation<string[] | Dirent[]> {
      const directory = path(value);
      const typed = directoryOptions(options);
      const result = yield* perform({ kind: typed ? "readdir-entries" : "readdir", path: directory });
      if (typed) {
        if (result.kind !== "entries") throw mismatch();
        return [...result.entries].sort((a, b) => compareNames(a.name, b.name)).map(entry => new Dirent(entry.name, entry.mode >>> 12, directory));
      }
      if (result.kind !== "names") throw mismatch();
      return [...result.names].sort(compareNames);
    }, 1, 2),
  };
}

export class Dirent {
  readonly #type: number;
  constructor(readonly name: string, type: number, readonly parentPath: string) { this.#type = type; }
  isFile(): boolean { return this.#type === 8; }
  isDirectory(): boolean { return this.#type === 4; }
  isSymbolicLink(): boolean { return this.#type === 10; }
  isBlockDevice(): boolean { return this.#type === 6; }
  isCharacterDevice(): boolean { return this.#type === 2; }
  isFIFO(): boolean { return this.#type === 1; }
  isSocket(): boolean { return this.#type === 12; }
}

function directoryOptions(options: unknown): boolean {
  let encoding: unknown;
  let typed = false;
  if (typeof options === "string") encoding = options;
  else if (options !== undefined && options !== null) {
    if (typeof options !== "object") throw Object.assign(new TypeError("Invalid readdir options"), { code: "ERR_INVALID_ARG_TYPE" });
    const recursive = "recursive" in options ? options.recursive : undefined;
    if (recursive !== undefined && typeof recursive !== "boolean") throw Object.assign(new TypeError("recursive must be a boolean"), { code: "ERR_INVALID_ARG_TYPE" });
    if (recursive === true) throw new TypeError("Unsupported recursive readdir");
    encoding = "encoding" in options ? options.encoding : undefined;
    typed = "withFileTypes" in options && Boolean(options.withFileTypes);
  }
  checkEncoding(encoding);
  return typed;
}
function compareNames(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

function checked<Args extends unknown[], Result>(operation: (...args: Args) => FileOperation<Result>, minimum: number, maximum: number) {
  return (...args: Args): FileOperation<Result> => {
    if (args.length < minimum || args.length > maximum) throw new TypeError("Unsupported filesystem argument count");
    return operation(...args);
  };
}

type FileStats = ReturnType<typeof fileStats>;
function fileStats(value: Extract<AssistanceResult, { kind: "stat" }>["stat"]) {
  const atimeMs = milliseconds(value.atimeNs);
  const mtimeMs = milliseconds(value.mtimeNs);
  const ctimeMs = milliseconds(value.ctimeNs);
  const birthtimeMs = milliseconds(value.details?.birthtimeNs ?? 0n);
  return {
    ...(value.details === null ? {} : { rdev: Number(value.details.rdev), birthtimeMs, birthtime: new Date(Math.round(birthtimeMs)) }),
    dev: Number(value.dev), ino: Number(value.ino), nlink: Number(value.nlink),
    size: Number(value.size), blocks: Number(value.blocks), blksize: value.blksize,
    mode: value.mode, uid: value.uid, gid: value.gid,
    atimeMs, mtimeMs, ctimeMs, atime: new Date(Math.round(atimeMs)), mtime: new Date(Math.round(mtimeMs)), ctime: new Date(Math.round(ctimeMs)),
    isFile: () => (value.mode & 0o170000) === 0o100000,
    isDirectory: () => (value.mode & 0o170000) === 0o040000,
    isSymbolicLink: () => (value.mode & 0o170000) === 0o120000,
    isBlockDevice: () => (value.mode & 0o170000) === 0o060000,
    isCharacterDevice: () => (value.mode & 0o170000) === 0o020000,
    isFIFO: () => (value.mode & 0o170000) === 0o010000,
    isSocket: () => (value.mode & 0o170000) === 0o140000,
  };
}

function milliseconds(nanoseconds: bigint): number {
  let seconds = nanoseconds / 1_000_000_000n;
  let fraction = nanoseconds % 1_000_000_000n;
  if (fraction < 0n) { seconds -= 1n; fraction += 1_000_000_000n; }
  return Number(seconds) * 1000 + Number(fraction) / 1e6;
}

function mkdirOptions(options: unknown): { recursive: boolean; mode: number } {
  let mode: unknown = 0o777;
  let recursive: unknown = false;
  if (typeof options === "number" || typeof options === "string") mode = options;
  else if (typeof options === "object" && options !== null) {
    const selectedMode = "mode" in options ? options.mode : undefined;
    const selectedRecursive = "recursive" in options ? options.recursive : undefined;
    if (selectedMode !== undefined) mode = selectedMode;
    if (selectedRecursive !== undefined) recursive = selectedRecursive;
  }
  if (typeof recursive !== "boolean") throw Object.assign(new TypeError("recursive must be a boolean"), { code: "ERR_INVALID_ARG_TYPE" });
  if (typeof mode === "string") {
    if (!/^[0-7]+$/.test(mode)) throw Object.assign(new TypeError("mode must be an octal string"), { code: "ERR_INVALID_ARG_VALUE" });
    mode = Number.parseInt(mode, 8);
  }
  if (typeof mode !== "number") throw Object.assign(new TypeError("mode must be a number or octal string"), { code: "ERR_INVALID_ARG_TYPE" });
  if (!Number.isInteger(mode) || mode < 0 || mode > 0xffff_ffff) throw Object.assign(new RangeError("mode must be an unsigned 32-bit integer"), { code: "ERR_OUT_OF_RANGE" });
  return { recursive, mode: mode & 0o7777 };
}

function accessMode(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number") throw Object.assign(new TypeError("Access mode must be a number"), { code: "ERR_INVALID_ARG_TYPE" });
  const mode = Math.trunc(value);
  if (!Number.isFinite(mode) || mode < 0 || mode > 7) throw Object.assign(new RangeError("Access mode must be between 0 and 7"), { code: "ERR_OUT_OF_RANGE" });
  return mode;
}

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError("Invalid filesystem integer");
  return value;
}
function descriptor(value: unknown): number {
  const result = number(value, 0xffff_ffff);
  if (result === 0) throw new RangeError("Invalid filesystem descriptor");
  return result;
}
function positionValue(value: unknown): bigint | null { return value === null ? null : BigInt(number(value)); }
function binary(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("Only Uint8Array and Buffer contents are supported");
  return value;
}
function checkEncoding(value: unknown): void {
  if (value !== undefined && value !== null && value !== "utf8" && value !== "utf-8") throw new TypeError("Only UTF-8 encoding is supported");
}
type BufferEncodingName = NonNullable<Parameters<Buffer["toString"]>[0]>;
function validBufferEncoding(value: unknown): value is BufferEncodingName { return typeof value === "string" && Buffer.isEncoding(value); }
function bufferEncoding(value: unknown, fallback: BufferEncodingName | null): BufferEncodingName | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw Object.assign(new TypeError("Encoding must be a string"), { code: "ERR_INVALID_ARG_TYPE" });
  const normalized = value.toLowerCase();
  if (!validBufferEncoding(normalized)) throw Object.assign(new TypeError(`Unknown encoding: ${value}`), { code: "ERR_UNKNOWN_ENCODING" });
  return normalized;
}
function contentOptions(value: unknown, defaultFlag: string) {
  const object = typeof value === "object" && value !== null ? value : null;
  if (object !== null && Object.keys(object).some(key => !["encoding", "flag", "mode", "flush"].includes(key))) throw new TypeError("Unsupported filesystem options");
  const at = (key: string): unknown => object === null ? undefined : Reflect.get(object, key);
  const encoding = bufferEncoding(object === null ? value : at("encoding"), null), flag = at("flag") ?? defaultFlag;
  const flush = at("flush") ?? false, mode = mkdirOptions({ mode: at("mode") ?? 0o666 }).mode;
  if (typeof flag !== "string" || !flags.includes(flag) || typeof flush !== "boolean") throw new TypeError("Invalid filesystem options");
  return { encoding, flag, mode, flush };
}
function noOptions(value: unknown): void {
  if (value !== undefined) throw new TypeError("Unsupported filesystem options");
}
function mismatch(): VMError { return new VMError("PROTOCOL_ERROR", "Filesystem reply does not match operation"); }

export function nodeResult(result: Extract<AssistanceResult, { kind: "error" }>): never;
export function nodeResult(result: AssistanceResult): Exclude<AssistanceResult, { kind: "error" }>;
export function nodeResult(result: AssistanceResult): Exclude<AssistanceResult, { kind: "error" }> {
  if (result.kind === "error") throw Object.assign(new Error(`${result.code}: ${result.syscall}`), {
    errno: -result.errno, code: result.code, syscall: result.syscall,
    ...(result.path === null ? {} : { path: result.path }),
    ...(result.destination === null ? {} : { dest: result.destination }),
  });
  return result;
}
