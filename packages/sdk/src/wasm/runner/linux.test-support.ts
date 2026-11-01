import type { FileDescriptor, LinuxFiles, LinuxFileStat, LinuxProcesses, LinuxSockets, LinuxSocketAddress, LinuxSyncFiles } from "../../js-process-types.js";
import { LinuxError, descriptor } from "../../runtime/js-process/codec.js";
import { VMError } from "../../runtime/errors.js";
import { decodeProcessId } from "../../values.js";
import type { LinuxParts } from "./host.js";

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
  | { readonly kind: "output"; readonly lines: string[] }
  | { readonly kind: "socket"; readonly receive: Channel; readonly send: Channel }
  | { readonly kind: "listener"; readonly key?: string; readonly incoming: Channel; readonly queue: FileDescriptor[] }
  | { readonly kind: "unbound" };

const text = (path: string | Uint8Array): string => typeof path === "string" ? path : new TextDecoder().decode(path);
const refuse = (name: string) => (): never => { throw new Error(`Unexpected call: ${name}`); };
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
}

export interface FakeLinux extends LinuxParts {
  readonly stdout: FileDescriptor;
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  readonly unlinked: string[];
  readonly closed: FileDescriptor[];
  /** Every write to a socket, with whether it asked for EPIPE instead of SIGPIPE on a closed peer. */
  readonly socketWrites: { readonly noSignal: boolean }[];
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
  const stdin = new Channel(), stdoutLines: string[] = [], stderrLines: string[] = [], unlinked: string[] = [], closed: FileDescriptor[] = [], socketWrites: { readonly noSignal: boolean }[] = [];
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
  table.set(1, { kind: "output", lines: stdoutLines });
  table.set(2, { kind: "output", lines: stderrLines });
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
    if (item.kind === "output") { item.lines.push(...decoder.decode(bytes).split("\n").filter(line => line !== "")); return; }
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
    open: refuse("files.open"), read, write: refuse("files.write"), seek: refuse("files.seek"),
    close: fd => { close(fd); return Promise.resolve(); },
    dup: refuse("files.dup"), pipe: refuse("files.pipe"),
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
    fstat: refuse("files.fstat"), readdir: refuse("files.readdir"), realpath: refuse("files.realpath"),
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
    fsync: refuse("files.fsync"),
    chmod: (path, mode) => {
      const name = text(path), file = written.get(name);
      if (file === undefined) return Promise.reject(new LinuxError(2));
      file.mode = mode & 0o7777;
      operations.push(`chmod ${name} ${(mode & 0o7777).toString(8)}`);
      return Promise.resolve();
    },
    fchmod: refuse("files.fchmod"), truncate: refuse("files.truncate"),
    ftruncate: refuse("files.ftruncate"), utimes: refuse("files.utimes"), link: refuse("files.link"), symlink: refuse("files.symlink"), readlink: refuse("files.readlink"),
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
    open: refuse("fs.open"), read: refuse("fs.read"), write: refuse("fs.write"), seek: refuse("fs.seek"), close: refuse("fs.close"), dup: refuse("fs.dup"), pipe: refuse("fs.pipe"),
    stat: refuse("fs.stat"), lstat: refuse("fs.lstat"), fstat: refuse("fs.fstat"), readdir: refuse("fs.readdir"), realpath: refuse("fs.realpath"),
    mkdir: () => undefined, rename: refuse("fs.rename"), unlink: refuse("fs.unlink"), fsync: refuse("fs.fsync"), chmod: refuse("fs.chmod"), fchmod: refuse("fs.fchmod"),
    truncate: refuse("fs.truncate"), ftruncate: refuse("fs.ftruncate"), utimes: refuse("fs.utimes"), link: refuse("fs.link"), symlink: refuse("fs.symlink"), readlink: refuse("fs.readlink"),
    readFile: refuse("fs.readFile"), writeFile: refuse("fs.writeFile"), writeAll,
  };
  const socketApi: LinuxSockets = {
    socket: () => { const fd = descriptor(next++); table.set(fd, { kind: "unbound" }); return Promise.resolve(fd); },
    // Only the probe of a Unix socket path is modelled: a live listener accepts, a leftover file refuses, nothing is missing.
    connect: (fd, address) => {
      handle(fd);
      if (address.family !== "unix") return Promise.reject(new LinuxError(111));
      const id = key(address);
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
    address: refuse("sockets.address"), shutdown: refuse("sockets.shutdown"), read, write: refuse("sockets.write"),
    close: fd => { close(fd); return Promise.resolve(); },
  };
  const process: LinuxProcesses = {
    info: () => Promise.resolve({ pid: decodeProcessId(42), parentPid: null, uid: 1000, gid: 1000, cwd: config.cwd ?? "/", args: config.args, environment: config.environment ?? [], terminal: null }),
    cwd: refuse("process.cwd"), chdir: refuse("process.chdir"), spawn: refuse("process.spawn"), wait: refuse("process.wait"), signal: refuse("process.signal"),
  };

  return {
    stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files, filesSync, sockets: socketApi, process,
    stdoutLines, stderrLines, unlinked, closed, socketWrites,
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
