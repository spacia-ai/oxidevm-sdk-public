import type { FileDescriptor, LinuxFiles, LinuxFileStat, LinuxProcesses, LinuxSockets, LinuxSocketAddress, LinuxSyncFiles } from "../../js-process-types.js";
import { LinuxError, descriptor } from "../../runtime/js-process/codec.js";
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
  | { readonly kind: "unbound" };

const text = (path: string | Uint8Array): string => typeof path === "string" ? path : new TextDecoder().decode(path);
/** An operation the in-memory Linux does not model: ENOSYS, as Linux answers a call it lacks. */
const unmodelled = (): never => { throw new LinuxError(38); };
const STAT: LinuxFileStat = { device: 0n, inode: 1n, links: 1n, mode: 0o100755, uid: 0, gid: 0, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n };

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
  /** Descriptors open right now (listeners, connections). */
  readonly open: ReadonlySet<FileDescriptor>;
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
  const written = new Map<string, { bytes: Uint8Array; mode: number; inode: bigint }>();
  const directories = new Set<string>(["/", "/workspace", "/tmp"]);
  const operations: string[] = [];
  for (const [path, file] of Object.entries(config.existingFiles ?? {})) written.set(path, { bytes: Uint8Array.from(file.bytes), mode: file.mode, inode: nextInode++ });
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

  const read = async (fd: FileDescriptor, count: number, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array> => {
    const item = handle(fd);
    if (item.kind === "stdin") return item.input.read(count, options?.signal);
    if (item.kind === "socket") return item.receive.read(count, options?.signal);
    throw new LinuxError(22);
  };
  const writeAll = (fd: FileDescriptor, bytes: Uint8Array, options?: { readonly noSignal?: boolean }): void => {
    const item = handle(fd);
    if (item.kind === "output") { item.bytes.push(Uint8Array.from(bytes)); item.lines.push(...decoder.decode(bytes).split("\n").filter(line => line !== "")); return; }
    if (item.kind === "socket") { socketWrites.push({ noSignal: options?.noSignal === true }); item.send.push(Uint8Array.from(bytes)); return; }
    throw new LinuxError(22);
  };
  const close = (fd: FileDescriptor): void => {
    const item = handle(fd);
    closed.push(fd);
    if (item.kind === "socket") item.send.end();
    if (item.kind === "listener") { if (item.key !== undefined) bound.delete(item.key); item.incoming.end(); }
    table.delete(fd);
  };
  const key = (address: LinuxSocketAddress): string => address.family === "unix" ? `unix:${address.path}` : `tcp:${String(address.port)}`;

  const files: LinuxFiles = {
    open: unmodelled, read, write: unmodelled, seek: unmodelled,
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
    fstat: unmodelled, readdir: unmodelled, realpath: unmodelled,
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
    fsync: unmodelled,
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
      written.set(name, { bytes: Uint8Array.from(bytes), mode: 0o644, inode: nextInode++ });
      operations.push(`write ${name}`);
      return Promise.resolve();
    },
    writeAll: (fd, bytes, options) => { writeAll(fd, bytes, options); return Promise.resolve(); },
  };
  const filesSync: LinuxSyncFiles = {
    open: unmodelled, read: unmodelled, write: unmodelled, seek: unmodelled, close: unmodelled, dup: unmodelled, pipe: unmodelled,
    stat: unmodelled, lstat: unmodelled, fstat: unmodelled, readdir: unmodelled, realpath: unmodelled,
    mkdir: () => undefined, rename: unmodelled, unlink: unmodelled, fsync: unmodelled, chmod: unmodelled, fchmod: unmodelled,
    truncate: unmodelled, ftruncate: unmodelled, utimes: unmodelled, link: unmodelled, symlink: unmodelled, readlink: unmodelled,
    readFile: path => { const file = written.get(text(path)); if (file === undefined) throw new LinuxError(2); return Uint8Array.from(file.bytes); },
    writeFile: (path, bytes) => {
      if (config.writeFailure !== undefined) throw new LinuxError(config.writeFailure);
      written.set(text(path), { bytes: Uint8Array.from(bytes), mode: 0o644, inode: nextInode++ }); operations.push(`write ${text(path)}`);
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
    address: unmodelled, shutdown: unmodelled, read, write: unmodelled,
    close: fd => { close(fd); return Promise.resolve(); },
  };
  const process: LinuxProcesses = {
    info: () => Promise.resolve({ pid: decodeProcessId(42), parentPid: null, uid: 1000, gid: 1000, cwd: config.cwd ?? "/", args: config.args, environment: config.environment ?? [], terminal: null }),
    cwd: unmodelled, chdir: unmodelled, spawn: unmodelled, wait: unmodelled, signal: unmodelled,
  };

  return {
    stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files, filesSync, sockets: socketApi, process,
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
