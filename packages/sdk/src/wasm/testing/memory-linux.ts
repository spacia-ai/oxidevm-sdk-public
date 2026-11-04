import type { ClockHost, FileDescriptor, LinuxFiles, LinuxFileStat, LinuxPath, LinuxProcessInfo, LinuxProcesses, LinuxSockets, LinuxSocketAddress, LinuxSyncFiles, ProcessSync, RandomHost, SeekOrigin } from "../../js-process-types.js";
import { LinuxError, descriptor } from "../../runtime/js-process/codec.js";
import { MemoryTree, memoryAtFiles, writeAt, type MemoryFile, type TreeHandle } from "./memory-files.js";
import { VMError } from "../../runtime/errors.js";
import { decodeProcessId } from "../../values.js";
import type { LinuxParts } from "../runner/host.js";
import type { ModuleReach } from "../reach.js";

/** One direction of a byte stream: readers wait for data, a signal can cancel a wait, and `end` is end of file. */
export class Channel {
  readonly #chunks: Uint8Array[] = [];
  readonly #waiting: (() => void)[] = [];
  #ended = false;
  push(bytes: Uint8Array): void { this.#chunks.push(bytes); this.#wake(); }
  /** Whether a read would return now: bytes are waiting or the stream has ended. */
  get ready(): boolean { return this.#chunks.length > 0 || this.#ended; }
  /** What a read finds now without waiting: bytes, end of file (empty), or null when it would wait. */
  readNow(count: number): Uint8Array | null {
    const next = this.#chunks[0];
    if (next === undefined) return this.#ended ? new Uint8Array() : null;
    if (next.length <= count) { this.#chunks.shift(); return next; }
    this.#chunks[0] = next.subarray(count);
    return next.subarray(0, count);
  }
  end(): void { this.#ended = true; this.#wake(); }
  #wake(): void { for (const wake of this.#waiting.splice(0)) wake(); }
  async read(count: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      signal?.throwIfAborted();
      const next = this.#chunks[0];
      if (next !== undefined) {
        if (next.length <= count) { this.#chunks.shift(); return next; }
        this.#chunks[0] = next.subarray(count);
        return next.subarray(0, count);
      }
      if (this.#ended) return new Uint8Array();
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.#waiting.splice(this.#waiting.indexOf(wake), 1); reject(signal?.reason instanceof Error ? signal.reason : new VMError("ABORTED", "aborted")); };
        this.#waiting.push(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

/** The client's end of a connection to a listening endpoint. */
export interface ClientEnd {
  write(bytes: Uint8Array): void;
  read(count: number): Promise<Uint8Array>;
  close(): void;
}

type Handle =
  | { readonly kind: "stdin"; readonly input: Channel }
  | { readonly kind: "output"; readonly lines: string[]; readonly bytes: Uint8Array[] }
  | { readonly kind: "socket"; readonly receive: Channel; readonly send: Channel }
  | { readonly kind: "listener"; readonly key?: string; readonly incoming: Channel; readonly queue: FileDescriptor[] }
  | { readonly kind: "unbound" }
  | TreeHandle;

const O_ACCMODE = 3, O_WRONLY = 1, O_RDWR = 2, O_APPEND = 0o2000, O_NONBLOCK = 0o4000, POLLIN = 1, POLLOUT = 4;
const text = (path: string | Uint8Array): string => typeof path === "string" ? path : new TextDecoder().decode(path);
/** An operation the in-memory Linux does not model: ENOSYS, as Linux answers a call it lacks. */
const unmodelled = (): never => { throw new LinuxError(38); };
const STAT: LinuxFileStat = { device: 0n, inode: 1n, links: 1n, mode: 0o100755, uid: 0, gid: 0, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n };
/** The standard streams are pipes: S_IFIFO with owner read and write. */
const STREAM_STAT: LinuxFileStat = { ...STAT, mode: 0o010600, uid: 1000, gid: 1000 };
/** The fake's clocks: realtime starts at 2026-01-01T00:00:00Z, monotonic at 1 s, and every reading moves both on by 1 ms. */
export const FAKE_CLOCK = { realtimeStartNs: 1_767_225_600_000_000_000n, monotonicStartNs: 1_000_000_000n, stepNs: 1_000_000n, resolutionNs: 1n } as const;

export interface FakeLinuxConfig {
  /** `info().args`: the launch descriptor first, then the command's own arguments. */
  readonly args: readonly string[];
  readonly environment?: readonly string[];
  readonly cwd?: string;
  /** Guest paths that exist, with their modes; every other path is ENOENT. */
  readonly paths?: Readonly<Record<string, number>>;
  /** Unix socket files left over from an earlier run. */
  readonly staleSockets?: readonly string[];
  /** Endpoints another process already holds (`unix:/path` or `tcp:port`). */
  readonly occupied?: readonly string[];
  /** Linux errno values that the first accept calls fail with, in order, before connections are returned. */
  readonly acceptFailures?: readonly number[];
  /** Regular files that exist when the process starts, with their permission bits. */
  readonly existingFiles?: Readonly<Record<string, { readonly bytes: Uint8Array; readonly mode: number }>>;
  /** The errno every `writeFile` fails with, to model a full or read-only disk. */
  readonly writeFailure?: number;
  /** What the process reads on standard input; it then sees end of file. Without it, input stays open until `endStdin`. */
  readonly stdin?: Uint8Array;
  /**
   * The module's declared network reach, which Rust enforces per module process (engine ADR 0029): without one, every
   * client connect, a Unix socket included, is refused with EACCES. Unrestricted when omitted.
   */
  readonly reach?: ModuleReach;
  /**
   * The seed of `random.fill`. The fake's entropy is NOT random: the same seed always gives the same bytes (a xorshift32
   * stream), so tests are reproducible. Never use it for anything secret.
   */
  readonly randomSeed?: number;
}

export interface FakeLinux extends LinuxParts {
  readonly stdout: FileDescriptor;
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  /** Everything written to standard output and standard error, byte for byte. */
  readonly stdoutBytes: () => Uint8Array;
  readonly stderrBytes: () => Uint8Array;
  readonly unlinked: string[];
  readonly closed: FileDescriptor[];
  /** Every write to a socket, with whether it asked for EPIPE instead of SIGPIPE on a closed peer. */
  readonly socketWrites: { readonly noSignal: boolean }[];
  /** Every client connect the process attempted (`unix:/path` or `tcp:port`), refused ones included. */
  readonly connects: string[];
  /** Ends the module's standard input, which asks a service to stop. */
  endStdin(): void;
  connect(endpoint: `unix:${string}` | `tcp:${number}`): ClientEnd;
  /** Another process removes the socket file at `path` and binds a new one there: same name, different inode. */
  replaceSocketFile(path: string): void;
  /** Regular files created through the file API, by path, with their permission bits. */
  readonly written: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mode: number }>;
  /** Every write, chmod, rename and mkdir made through the file API, in order. */
  readonly operations: string[];
  /** Endpoints currently listening. */
  listening(): readonly string[];
  /** Descriptors open right now (listeners, connections, files and directories). */
  readonly open: ReadonlySet<FileDescriptor>;
  /** Symbolic links created through `host.at`, by path, with the target bytes they store. */
  readonly symlinks: ReadonlyMap<string, Uint8Array>;
  /** Moves the fake's clocks on by `ns` nanoseconds without a reading. */
  advanceClock(ns: bigint): void;
}

/** An in-memory Linux process: enough sockets, pipes and files to drive the runner without an engine. */
export function fakeLinux(config: FakeLinuxConfig): FakeLinux {
  const table = new Map<number, Handle>();
  const stdin = new Channel(), stdoutLines: string[] = [], stderrLines: string[] = [], unlinked: string[] = [], closed: FileDescriptor[] = [], socketWrites: { readonly noSignal: boolean }[] = [], connects: string[] = [];
  const sockets = new Set<string>();
  /** Socket files by path, each with the inode it was created with. */
  const inodes = new Map<string, bigint>();
  let nextInode = 100n;
  const createSocketFile = (path: string): void => { sockets.add(path); inodes.set(path, nextInode++); };
  for (const path of config.staleSockets ?? []) createSocketFile(path);
  /** Regular files from `paths` that were unlinked. */
  const removedFiles = new Set<string>();
  /** Files and directories created through the file API. */
  const written = new Map<string, MemoryFile>();
  const directories = new Set<string>(["/", "/workspace", "/tmp"]);
  const operations: string[] = [];
  let clock = 0n;
  const realtime = (): bigint => FAKE_CLOCK.realtimeStartNs + clock;
  const created = (bytes: Uint8Array, mode: number): MemoryFile => ({ bytes: Uint8Array.from(bytes), mode, inode: nextInode++, accessedNs: realtime(), modifiedNs: realtime(), changedNs: realtime() });
  for (const [path, file] of Object.entries(config.existingFiles ?? {})) written.set(path, created(file.bytes, file.mode));
  const acceptFailures = [...config.acceptFailures ?? []];
  const bound = new Map<string, FileDescriptor>();
  const occupied = new Set(config.occupied ?? []);
  let next = 10;
  table.set(0, { kind: "stdin", input: stdin });
  const stdoutBytes: Uint8Array[] = [], stderrBytes: Uint8Array[] = [];
  table.set(1, { kind: "output", lines: stdoutLines, bytes: stdoutBytes });
  table.set(2, { kind: "output", lines: stderrLines, bytes: stderrBytes });
  if (config.stdin !== undefined) { if (config.stdin.length > 0) stdin.push(Uint8Array.from(config.stdin)); stdin.end(); }
  const joined = (parts: readonly Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
  const decoder = new TextDecoder();
  const handle = (fd: FileDescriptor): Handle => {
    const found = table.get(fd);
    if (found === undefined) throw new LinuxError(9);
    return found;
  };

  /** Status flags of the descriptors the tree does not own; the standard streams start O_RDONLY and O_WRONLY. */
  const streamFlags = new Map<number, number>([[0, 0], [1, 1], [2, 1]]);
  const tree = new MemoryTree(written, directories, {
    cwd: config.cwd ?? "/", operations, unlinked,
    handle: fd => { const item = table.get(fd); return item?.kind === "file" || item?.kind === "directory" ? item : undefined; },
    isOpen: fd => table.has(fd),
    open: item => { const fd = descriptor(next++); table.set(fd, item); return fd; },
    streamReadiness: (fd, events) => {
      const item = table.get(fd);
      if (item === undefined) return undefined;
      const input = item.kind === "stdin" ? item.input : item.kind === "socket" ? item.receive : undefined;
      return ((events & POLLIN) !== 0 && input?.ready === true ? POLLIN : 0) | ((events & POLLOUT) !== 0 && (item.kind === "output" || item.kind === "socket") ? POLLOUT : 0);
    },
    streamFlags: fd => table.has(fd) ? { get: () => streamFlags.get(fd) ?? O_RDWR, set: flags => { streamFlags.set(fd, flags); } } : undefined,
    now: realtime,
    advance: ms => { clock += BigInt(ms) * 1_000_000n; },
    known: path => removedFiles.has(path) ? undefined : config.paths?.[path],
  }, () => nextInode++);
  const at = memoryAtFiles(tree);

  const readFrom = (item: TreeHandle & { readonly kind: "file" }, count: number): Uint8Array => {
    if ((item.flags & O_ACCMODE) === O_WRONLY) throw new LinuxError(9);
    const start = Number(item.offset), bytes = item.file.bytes.slice(start, start + count);
    item.offset += BigInt(bytes.length);
    return bytes;
  };
  const read = async (fd: FileDescriptor, count: number, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array> => {
    const item = handle(fd);
    if (item.kind === "stdin") return item.input.read(count, options?.signal);
    if (item.kind === "socket") return item.receive.read(count, options?.signal);
    if (item.kind === "file") return readFrom(item, count);
    throw new LinuxError(item.kind === "directory" ? 21 : 22);
  };
  /** A read that cannot wait: what has arrived, EAGAIN for O_NONBLOCK, or a typed refusal instead of hanging the test. */
  const readSync = (fd: FileDescriptor, count: number): Uint8Array => {
    const item = handle(fd);
    if (item.kind === "file") return readFrom(item, count);
    const input = item.kind === "stdin" ? item.input : item.kind === "socket" ? item.receive : undefined;
    if (input === undefined) throw new LinuxError(item.kind === "directory" ? 21 : 22);
    const bytes = input.readNow(count);
    if (bytes !== null) return bytes;
    if (((streamFlags.get(fd) ?? 0) & O_NONBLOCK) !== 0) throw new LinuxError(11);
    throw new VMError("FEATURE_NOT_AVAILABLE", "testHost: a blocking read with nothing to read would wait forever (supply stdin, or end it)", { reason: "testhost-blocked-read" });
  };
  /** One write: all of `bytes`, to an output, a socket or a file (at its offset, or its end with O_APPEND). */
  const write = (fd: FileDescriptor, bytes: Uint8Array, options?: { readonly noSignal?: boolean }): number => {
    const item = handle(fd);
    if (item.kind === "output") { item.bytes.push(Uint8Array.from(bytes)); item.lines.push(...decoder.decode(bytes).split("\n").filter(line => line !== "")); return bytes.length; }
    if (item.kind === "socket") { socketWrites.push({ noSignal: options?.noSignal === true }); item.send.push(Uint8Array.from(bytes)); return bytes.length; }
    if (item.kind === "file") {
      if ((item.flags & O_ACCMODE) === 0) throw new LinuxError(9);
      const offset = (item.flags & O_APPEND) !== 0 ? item.file.bytes.length : Number(item.offset);
      writeAt(item, bytes, offset, realtime()); item.offset = BigInt(offset + bytes.length);
      return bytes.length;
    }
    throw new LinuxError(item.kind === "stdin" ? 9 : item.kind === "directory" ? 21 : 22);
  };
  const writeAll = (fd: FileDescriptor, bytes: Uint8Array, options?: { readonly noSignal?: boolean }): void => { write(fd, bytes, options); };
  const seek = (fd: FileDescriptor, offset: bigint, origin: SeekOrigin = "start"): bigint => {
    const item = handle(fd);
    if (item.kind !== "file" && item.kind !== "directory") throw new LinuxError(29);
    const base = origin === "start" ? 0n : origin === "current" ? item.offset : item.kind === "file" ? BigInt(item.file.bytes.length) : 0n;
    if (item.kind === "directory" && origin === "end") throw new LinuxError(22);
    const position = base + offset;
    if (position < 0n) throw new LinuxError(22);
    item.offset = position;
    return position;
  };
  const fstat = (fd: FileDescriptor): LinuxFileStat => {
    const item = handle(fd);
    if (item.kind === "file") return tree.stat(item.path, { kind: "file", file: item.file });
    if (item.kind === "directory") return tree.stat(item.path, { kind: "directory" });
    if (item.kind === "stdin" || item.kind === "output") return STREAM_STAT;
    return { ...STREAM_STAT, mode: 0o140777 };
  };
  const syncFlush = (fd: FileDescriptor): void => { const item = handle(fd); if (item.kind !== "file" && item.kind !== "directory") throw new LinuxError(22); };
  const openPath = (path: LinuxPath, flags = 0, mode = 0o666): FileDescriptor => at.openat(at.cwd, path, flags, mode);
  const info = (): LinuxProcessInfo => ({ pid: decodeProcessId(42), parentPid: null, uid: 1000, gid: 1000, cwd: config.cwd ?? "/", args: config.args, environment: config.environment ?? [], terminal: null });
  /** xorshift32: deterministic test bytes, never entropy. */
  let seed = (config.randomSeed ?? 0x9e37_79b9) >>> 0 || 1;
  const random: RandomHost = Object.freeze({
    fill: (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index++) { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; bytes[index] = seed & 0xff; }
    },
  });
  const reading = (start: bigint): bigint => { const value = start + clock; clock += FAKE_CLOCK.stepNs; return value; };
  const clockHost: ClockHost = Object.freeze({
    now: (which: "realtime" | "monotonic") => reading(which === "realtime" ? FAKE_CLOCK.realtimeStartNs : FAKE_CLOCK.monotonicStartNs),
    resolution: () => FAKE_CLOCK.resolutionNs,
  });
  const processSync: ProcessSync = Object.freeze({ infoSync: info, spawnSync: unmodelled, waitSync: unmodelled, signalSync: unmodelled, runSync: unmodelled });
  const close = (fd: FileDescriptor): void => {
    const item = handle(fd);
    closed.push(fd);
    if (item.kind === "socket") item.send.end();
    if (item.kind === "listener") { if (item.key !== undefined) bound.delete(item.key); item.incoming.end(); }
    table.delete(fd);
  };
  const key = (address: LinuxSocketAddress): string => address.family === "unix" ? `unix:${address.path}` : `tcp:${String(address.port)}`;

  const files: LinuxFiles = {
    open: (path, flags, mode) => Promise.resolve().then(() => openPath(path, flags, mode)), read,
    write: (fd, bytes, options) => Promise.resolve().then(() => write(fd, bytes, options)),
    seek: (fd, offset, origin) => Promise.resolve().then(() => seek(fd, offset, origin)),
    close: fd => { close(fd); return Promise.resolve(); },
    dup: unmodelled, pipe: unmodelled,
    stat: path => { const mode = config.paths?.[text(path)]; return mode === undefined ? Promise.reject(new LinuxError(2)) : Promise.resolve({ ...STAT, mode }); },
    lstat: path => {
      const name = text(path);
      const file = written.get(name);
      if (file !== undefined) return Promise.resolve({ ...STAT, mode: 0o100000 | file.mode, size: BigInt(file.bytes.length), inode: file.inode });
      if (directories.has(name)) return Promise.resolve({ ...STAT, mode: 0o040755 });
      if (sockets.has(name)) return Promise.resolve({ ...STAT, mode: 0o140755, inode: inodes.get(name) ?? 1n });
      const mode = removedFiles.has(name) ? undefined : config.paths?.[name];
      return mode === undefined ? Promise.reject(new LinuxError(2)) : Promise.resolve({ ...STAT, mode });
    },
    fstat: fd => Promise.resolve().then(() => fstat(fd)), readdir: unmodelled, realpath: unmodelled,
    mkdir: path => {
      const name = text(path);
      if (directories.has(name) || written.has(name)) return Promise.reject(new LinuxError(17));
      directories.add(name);
      operations.push(`mkdir ${name}`);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const source = text(from), target = text(to), file = written.get(source);
      if (file === undefined) return Promise.reject(new LinuxError(2));
      written.delete(source);
      written.set(target, file);
      operations.push(`rename ${source} -> ${target}`);
      return Promise.resolve();
    },
    unlink: path => {
      const name = text(path);
      if (written.delete(name)) { unlinked.push(name); return Promise.resolve(); }
      if (sockets.delete(name)) { inodes.delete(name); unlinked.push(name); return Promise.resolve(); }
      if (config.paths?.[name] !== undefined && !removedFiles.has(name)) { removedFiles.add(name); unlinked.push(name); return Promise.resolve(); }
      return Promise.reject(new LinuxError(2));
    },
    fsync: fd => Promise.resolve().then(() => { syncFlush(fd); }),
    chmod: (path, mode) => {
      const name = text(path), file = written.get(name);
      if (file === undefined) return Promise.reject(new LinuxError(2));
      file.mode = mode & 0o7777;
      operations.push(`chmod ${name} ${(mode & 0o7777).toString(8)}`);
      return Promise.resolve();
    },
    fchmod: unmodelled, truncate: unmodelled,
    ftruncate: unmodelled, utimes: unmodelled, link: unmodelled, symlink: unmodelled, readlink: unmodelled,
    readFile: path => { const file = written.get(text(path)); return file === undefined ? Promise.reject(new LinuxError(2)) : Promise.resolve(Uint8Array.from(file.bytes)); },
    writeFile: (path, bytes) => {
      const name = text(path);
      if (config.writeFailure !== undefined) return Promise.reject(new LinuxError(config.writeFailure));
      written.set(name, created(bytes, 0o644));
      operations.push(`write ${name}`);
      return Promise.resolve();
    },
    writeAll: (fd, bytes, options) => { writeAll(fd, bytes, options); return Promise.resolve(); },
  };
  const filesSync: LinuxSyncFiles = {
    open: openPath, read: readSync, write, seek, close, dup: unmodelled, pipe: unmodelled,
    stat: unmodelled, lstat: unmodelled, fstat, readdir: unmodelled, realpath: unmodelled,
    mkdir: () => undefined, rename: unmodelled, unlink: unmodelled, fsync: syncFlush, chmod: unmodelled, fchmod: unmodelled,
    truncate: unmodelled, ftruncate: unmodelled, utimes: unmodelled, link: unmodelled, symlink: unmodelled, readlink: unmodelled,
    readFile: path => { const file = written.get(text(path)); if (file === undefined) throw new LinuxError(2); return Uint8Array.from(file.bytes); },
    writeFile: (path, bytes) => {
      if (config.writeFailure !== undefined) throw new LinuxError(config.writeFailure);
      written.set(text(path), created(bytes, 0o644)); operations.push(`write ${text(path)}`);
    },
    writeAll,
  };
  const socketApi: LinuxSockets = {
    socket: () => { const fd = descriptor(next++); table.set(fd, { kind: "unbound" }); return Promise.resolve(fd); },
    // Only the probe of a Unix socket path is modelled: a live listener accepts, a leftover file refuses, nothing is missing.
    connect: (fd, address) => {
      handle(fd);
      const id = key(address);
      connects.push(id);
      if (config.reach === "none") return Promise.reject(new LinuxError(13));
      if (address.family !== "unix") return Promise.reject(new LinuxError(111));
      if (occupied.has(id) || bound.has(id)) return Promise.resolve();
      return Promise.reject(new LinuxError(sockets.has(address.path) ? 111 : 2));
    },
    bind: (fd, address) => {
      handle(fd);
      const id = key(address);
      if (bound.has(id) || occupied.has(id)) return Promise.reject(new LinuxError(98));
      table.set(fd, { kind: "listener", key: id, incoming: new Channel(), queue: [] });
      bound.set(id, fd);
      // Binding a Unix socket creates its file, which stays until someone unlinks it.
      if (address.family === "unix") createSocketFile(address.path);
      return Promise.resolve();
    },
    listen: () => Promise.resolve(),
    accept: async (fd, options) => {
      const failure = acceptFailures.shift();
      if (failure !== undefined) throw new LinuxError(failure);
      const item = handle(fd);
      if (item.kind !== "listener") throw new LinuxError(22);
      for (;;) {
        const queued = item.queue.shift();
        if (queued !== undefined) return queued;
        if ((await item.incoming.read(1, options?.signal)).length === 0 && item.queue.length === 0) throw new LinuxError(22);
      }
    },
    address: unmodelled, shutdown: unmodelled, read, write: (fd, bytes, options) => Promise.resolve().then(() => write(fd, bytes, options)),
    close: fd => { close(fd); return Promise.resolve(); },
  };
  const process: LinuxProcesses = {
    info: () => Promise.resolve(info()),
    cwd: unmodelled, chdir: unmodelled, spawn: unmodelled, wait: unmodelled, signal: unmodelled,
  };

  return {
    stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files, filesSync, sockets: socketApi, process,
    filesAt: at, clock: clockHost, random, processSync, symlinks: tree.symlinks,
    advanceClock: ns => { if (ns < 0n) throw new VMError("INVALID_ARGUMENT", "the fake clock only moves forward"); clock += ns; },
    stdoutLines, stderrLines, unlinked, closed, socketWrites, connects,
    stdoutBytes: () => joined(stdoutBytes), stderrBytes: () => joined(stderrBytes),
    endStdin: () => { stdin.end(); },
    replaceSocketFile: path => { inodes.set(path, nextInode++); },
    written, operations,
    listening: () => [...bound.keys()],
    get open() { return new Set([...table.keys()].filter(fd => fd >= 10).map(descriptor)); },
    connect(endpoint) {
      const listener = bound.get(endpoint);
      const item = listener === undefined ? undefined : handle(listener);
      if (item?.kind !== "listener") throw new LinuxError(111);
      const toServer = new Channel(), toClient = new Channel(), fd = descriptor(next++);
      table.set(fd, { kind: "socket", receive: toServer, send: toClient });
      item.queue.push(fd);
      item.incoming.push(Uint8Array.of(1));
      return { write: bytes => { toServer.push(Uint8Array.from(bytes)); }, read: count => toClient.read(count), close: () => { toServer.end(); } };
    },
  };
}
