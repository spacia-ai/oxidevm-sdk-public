import type { FileDescriptor, LinuxAtFiles, LinuxDirent, LinuxFileStat, LinuxNanoTime, LinuxPath, LinuxPollReady } from "../../js-process-types.js";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { CWD } from "../../runtime/js-process/at-operations.js";
import { VMError } from "../../runtime/errors.js";

/**
 * The in-memory file tree behind `fakeLinux`'s file facades and its `host.at` (capability `files.at`): regular files,
 * directories and symbolic links by absolute path, with Linux's errnos for what it models. It is a test double for
 * adapter unit tests, not Linux: Rust owns path resolution in a VM, and this tree models only what an adapter needs to be
 * exercised (descriptor-relative paths, RESOLVE_BENEATH, positional I/O, directory cookies, times and readiness).
 */
export interface MemoryFile { bytes: Uint8Array; mode: number; inode: bigint; accessedNs: bigint; modifiedNs: bigint; changedNs: bigint }
/** An open file or directory in the fake's descriptor table. */
export type TreeHandle =
  | { readonly kind: "file"; readonly path: string; readonly file: MemoryFile; flags: number; offset: bigint }
  | { readonly kind: "directory"; readonly path: string; flags: number; offset: bigint };

/** The rest of the fake process the tree needs: its descriptor table, its clock, and how other descriptors behave. */
export interface TreeProcess {
  readonly cwd: string;
  readonly operations: string[];
  readonly unlinked: string[];
  /** The tree's handle for `fd`, or undefined when it is another kind of descriptor (a stream, a socket). */
  handle(fd: FileDescriptor): TreeHandle | undefined;
  /** Whether `fd` is open at all. */
  isOpen(fd: FileDescriptor): boolean;
  open(handle: TreeHandle): FileDescriptor;
  /** The readiness of a descriptor the tree does not own (POLLIN 1, POLLOUT 4, POLLHUP 16), or undefined when it is closed. */
  streamReadiness(fd: FileDescriptor, events: number): number | undefined;
  /** Status flags of a descriptor the tree does not own. */
  streamFlags(fd: FileDescriptor): { get(): number; set(flags: number): void } | undefined;
  /** The fake's realtime clock, for `"now"`. */
  now(): bigint;
  /** Moves the fake's clocks on by `ms` (a poll that times out). */
  advance(ms: number): void;
  /** Paths from the fake's config that exist with only a mode. */
  known(path: string): number | undefined;
}

const ENOENT = 2, EBADF = 9, EEXIST = 17, EXDEV = 18, ENOTDIR = 20, EISDIR = 21, EINVAL = 22, ESPIPE = 29, ELOOP = 40, ENOTEMPTY = 39, EPERM = 1;
const O_ACCMODE = 3, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000, O_NONBLOCK = 0o4000, O_DIRECTORY = 0o200000, O_NOFOLLOW = 0o400000;
const AT_SYMLINK_NOFOLLOW = 0x100, AT_REMOVEDIR = 0x200, AT_SYMLINK_FOLLOW = 0x400, AT_EMPTY_PATH = 0x1000;
const RESOLVE_NO_SYMLINKS = 0x04, RESOLVE_BENEATH = 0x08, RENAME_NOREPLACE = 1, RENAME_EXCHANGE = 2;
const DT_DIR = 4, DT_REG = 8, DT_LNK = 10, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const decoder = new TextDecoder();
const text = (path: LinuxPath): string => typeof path === "string" ? path : decoder.decode(path);
function fail(errno: number): never { throw new LinuxError(errno); }
const parentOf = (path: string): string => path === "/" ? "/" : path.slice(0, path.lastIndexOf("/")) || "/";
const join = (directory: string, name: string): string => directory === "/" ? `/${name}` : `${directory}/${name}`;
/** The `d_reclen` of a getdents64 record: 19 header bytes, the name, its NUL, aligned to 8. */
const recordLength = (name: Uint8Array): number => Math.ceil((19 + name.byteLength + 1) / 8) * 8;

type Node = { readonly kind: "file"; readonly file: MemoryFile } | { readonly kind: "directory" } | { readonly kind: "symlink"; readonly target: Uint8Array } | { readonly kind: "known"; readonly mode: number };

/** Regular files, directories and symbolic links, keyed by absolute path. `files` and `directories` are the fake's own. */
export class MemoryTree {
  readonly symlinks = new Map<string, Uint8Array>();
  readonly #inodes = new Map<string, bigint>();
  constructor(readonly files: Map<string, MemoryFile>, readonly directories: Set<string>, readonly process: TreeProcess, private nextInode: () => bigint) {}

  node(path: string): Node | undefined {
    const file = this.files.get(path);
    if (file !== undefined) return { kind: "file", file };
    if (this.directories.has(path)) return { kind: "directory" };
    const target = this.symlinks.get(path);
    if (target !== undefined) return { kind: "symlink", target };
    const mode = this.process.known(path);
    return mode === undefined ? undefined : { kind: "known", mode };
  }
  #inode(path: string): bigint { const known = this.#inodes.get(path); if (known !== undefined) return known; const inode = this.nextInode(); this.#inodes.set(path, inode); return inode; }

  /**
   * An absolute path for `path` relative to `base`, following symbolic links in every component and, when `follow`, in
   * the last. `beneath` (RESOLVE_BENEATH) refuses with EXDEV anything that leaves `base`: `..` above it, an absolute path
   * or an absolute link target. Intermediate components must be directories.
   */
  resolve(base: string, path: string, options: { readonly follow: boolean; readonly beneath?: boolean; readonly noSymlinks?: boolean }): string {
    if (path === "") fail(ENOENT);
    let hops = 0;
    const walk = (start: string, rest: string, followLast: boolean): string => {
      if (rest.startsWith("/")) { if (options.beneath === true) fail(EXDEV); start = "/"; }
      const parts = rest.split("/").filter(part => part !== "" && part !== ".");
      let current = start;
      parts.forEach((part, index) => {
        const last = index === parts.length - 1;
        if (part === "..") {
          if (options.beneath === true && (current === base || !current.startsWith(base === "/" ? "/" : `${base}/`))) fail(EXDEV);
          current = parentOf(current); return;
        }
        const next = join(current, part), node = this.node(next);
        if (node?.kind === "symlink" && (!last || followLast)) {
          if (options.noSymlinks === true || ++hops > 40) fail(ELOOP);
          // A link's target resolves from the link's directory, and its own last component is always followed.
          current = walk(current, decoder.decode(node.target), true);
          return;
        }
        if (!last && node?.kind !== "directory") fail(node === undefined ? ENOENT : ENOTDIR);
        current = next;
      });
      return current;
    };
    return walk(base, path, options.follow);
  }

  stat(path: string, node: Node): LinuxFileStat {
    const base = { device: 1n, links: 1n, uid: 1000, gid: 1000, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n };
    switch (node.kind) {
      case "file": return { ...base, inode: node.file.inode, mode: S_IFREG | node.file.mode, size: BigInt(node.file.bytes.byteLength), accessedNs: node.file.accessedNs, modifiedNs: node.file.modifiedNs, changedNs: node.file.changedNs };
      case "directory": return { ...base, inode: this.#inode(path), mode: S_IFDIR | 0o755, links: 2n };
      case "symlink": return { ...base, inode: this.#inode(path), mode: S_IFLNK | 0o777, size: BigInt(node.target.byteLength) };
      case "known": return { ...base, inode: this.#inode(path), mode: node.mode };
    }
  }
  /** The names in a directory, sorted, without `.` and `..`. */
  list(directory: string): readonly string[] {
    const prefix = directory === "/" ? "/" : `${directory}/`, names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.directories, ...this.symlinks.keys()]) {
      if (path !== directory && path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) names.add(path.slice(prefix.length));
    }
    return [...names].sort();
  }
  #requireParent(path: string): void { if (this.node(parentOf(path))?.kind !== "directory") fail(ENOENT); }
  newFile(bytes: Uint8Array, mode: number): MemoryFile {
    const now = this.process.now();
    return { bytes: Uint8Array.from(bytes), mode: mode & 0o7777, inode: this.nextInode(), accessedNs: now, modifiedNs: now, changedNs: now };
  }
  mkdir(path: string): void { if (this.node(path) !== undefined) fail(EEXIST); this.#requireParent(path); this.directories.add(path); this.process.operations.push(`mkdir ${path}`); }
  remove(path: string, directory: boolean): void {
    const node = this.node(path) ?? fail(ENOENT);
    if (directory) {
      if (node.kind !== "directory") fail(ENOTDIR);
      if (this.list(path).length > 0) fail(ENOTEMPTY);
      this.directories.delete(path);
    } else {
      if (node.kind === "directory") fail(EISDIR);
      if (node.kind === "known") fail(EPERM);
      this.files.delete(path); this.symlinks.delete(path);
    }
    this.#inodes.delete(path); this.process.unlinked.push(path);
  }
  /** Moves the node at `from`, and everything beneath a directory, to `to`. */
  #move(from: string, to: string): void {
    const moves: [string, string][] = [];
    for (const path of [...this.files.keys(), ...this.directories, ...this.symlinks.keys()]) if (path === from || path.startsWith(`${from}/`)) moves.push([path, to + path.slice(from.length)]);
    const taken = moves.map(([path, next]) => ({ next, file: this.files.get(path), directory: this.directories.has(path), link: this.symlinks.get(path), path }));
    for (const entry of taken) { this.files.delete(entry.path); this.directories.delete(entry.path); this.symlinks.delete(entry.path); }
    for (const entry of taken) { if (entry.file !== undefined) this.files.set(entry.next, entry.file); if (entry.directory) this.directories.add(entry.next); if (entry.link !== undefined) this.symlinks.set(entry.next, entry.link); }
  }
  rename(from: string, to: string, flags: number): void {
    if ((flags & ~(RENAME_NOREPLACE | RENAME_EXCHANGE)) !== 0 || flags === (RENAME_NOREPLACE | RENAME_EXCHANGE)) fail(EINVAL);
    const source = this.node(from) ?? fail(ENOENT), target = this.node(to);
    this.#requireParent(to);
    if (from === to) return;
    if (to.startsWith(`${from}/`)) fail(EINVAL);
    if ((flags & RENAME_EXCHANGE) !== 0) {
      if (target === undefined) fail(ENOENT);
      const parked = `${to}\0exchange`;
      this.#move(to, parked); this.#move(from, to); this.#move(parked, from);
    } else {
      if (target !== undefined && (flags & RENAME_NOREPLACE) !== 0) fail(EEXIST);
      if (target?.kind === "directory" && source.kind !== "directory") fail(EISDIR);
      if (target !== undefined && source.kind === "directory" && target.kind !== "directory") fail(ENOTDIR);
      if (target?.kind === "directory" && this.list(to).length > 0) fail(ENOTEMPTY);
      if (target !== undefined) this.remove(to, target.kind === "directory");
      this.#move(from, to);
    }
    this.process.operations.push(`rename ${from} -> ${to}`);
  }
  link(from: string, to: string): void {
    const node = this.node(from) ?? fail(ENOENT);
    if (node.kind === "directory") fail(EPERM);
    if (this.node(to) !== undefined) fail(EEXIST);
    this.#requireParent(to);
    if (node.kind === "file") this.files.set(to, node.file);
    else if (node.kind === "symlink") this.symlinks.set(to, node.target);
    else fail(EPERM);
  }
  symlink(target: Uint8Array, path: string): void {
    if (target.byteLength === 0) fail(ENOENT);
    if (this.node(path) !== undefined) fail(EEXIST);
    this.#requireParent(path);
    this.symlinks.set(path, Uint8Array.from(target));
  }
}

const DIRECTORY_ACCESS = 0;
const timeOf = (time: LinuxNanoTime, current: bigint, now: bigint): bigint => time === "now" ? now : time === "omit" ? current : time;

/** `host.at` over the tree: every path resolves against the descriptor's directory, or the fake's cwd for AT_FDCWD. */
export function memoryAtFiles(tree: MemoryTree): LinuxAtFiles {
  const { process } = tree;
  const directoryOf = (dir: FileDescriptor): string => {
    if (dir === CWD) return process.cwd;
    const handle = process.handle(dir);
    if (handle === undefined) return fail(process.isOpen(dir) ? ENOTDIR : EBADF);
    if (handle.kind !== "directory") fail(ENOTDIR);
    return handle.path;
  };
  const handleOf = (fd: FileDescriptor): TreeHandle => process.handle(fd) ?? fail(process.isOpen(fd) ? ESPIPE : EBADF);
  const fileOf = (fd: FileDescriptor): TreeHandle & { readonly kind: "file" } => { const handle = handleOf(fd); if (handle.kind !== "file") fail(EISDIR); return handle; };
  /** The node a call names, or `dir` itself for an empty path with AT_EMPTY_PATH. */
  const target = (dir: FileDescriptor, path: LinuxPath, flags: number, follow: boolean): string => {
    if (text(path) === "" && (flags & AT_EMPTY_PATH) !== 0) {
      if (dir === CWD) return process.cwd;
      return handleOf(dir).path;
    }
    return tree.resolve(directoryOf(dir), text(path), { follow });
  };
  const offsetOf = (offset: bigint): number => { if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) fail(EINVAL); return Number(offset); };
  const api: LinuxAtFiles = {
    cwd: CWD,
    openat(dir, path, flags, mode, resolve = 0) {
      if ((resolve & ~(RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH)) !== 0) fail(EINVAL);
      const absolute = tree.resolve(directoryOf(dir), text(path), { follow: (flags & O_NOFOLLOW) === 0, beneath: (resolve & RESOLVE_BENEATH) !== 0, noSymlinks: (resolve & RESOLVE_NO_SYMLINKS) !== 0 });
      let node = tree.node(absolute);
      if (node?.kind === "symlink") fail(ELOOP);
      if (node === undefined) {
        if ((flags & O_CREAT) === 0) fail(ENOENT);
        if ((flags & O_DIRECTORY) !== 0) fail(EINVAL);
        if (tree.node(parentOf(absolute))?.kind !== "directory") fail(ENOENT);
        const file = tree.newFile(new Uint8Array(), mode);
        tree.files.set(absolute, file); process.operations.push(`write ${absolute}`);
        node = { kind: "file", file };
      } else if ((flags & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL)) fail(EEXIST);
      if (node.kind === "directory") {
        if ((flags & O_ACCMODE) !== DIRECTORY_ACCESS || (flags & O_CREAT) !== 0) fail(EISDIR);
        return process.open({ kind: "directory", path: absolute, flags, offset: 0n });
      }
      if ((flags & O_DIRECTORY) !== 0) fail(ENOTDIR);
      if (node.kind !== "file") fail(EPERM);
      if ((flags & O_TRUNC) !== 0 && (flags & O_ACCMODE) !== 0) { node.file.bytes = new Uint8Array(); node.file.modifiedNs = process.now(); }
      return process.open({ kind: "file", path: absolute, file: node.file, flags, offset: 0n });
    },
    statAt(dir, path, flags = 0) {
      const absolute = target(dir, path, flags, (flags & AT_SYMLINK_NOFOLLOW) === 0);
      return tree.stat(absolute, tree.node(absolute) ?? fail(ENOENT));
    },
    mkdirAt(dir, path) { tree.mkdir(tree.resolve(directoryOf(dir), text(path), { follow: false })); },
    unlinkAt(dir, path, flags = 0) {
      if ((flags & ~AT_REMOVEDIR) !== 0) fail(EINVAL);
      tree.remove(tree.resolve(directoryOf(dir), text(path), { follow: false }), (flags & AT_REMOVEDIR) !== 0);
    },
    renameAt(fromDir, from, toDir, to, flags = 0) {
      tree.rename(tree.resolve(directoryOf(fromDir), text(from), { follow: false }), tree.resolve(directoryOf(toDir), text(to), { follow: false }), flags);
    },
    linkAt(fromDir, from, toDir, to, flags = 0) {
      if ((flags & ~(AT_SYMLINK_FOLLOW | AT_EMPTY_PATH)) !== 0) fail(EINVAL);
      tree.link(target(fromDir, from, flags, (flags & AT_SYMLINK_FOLLOW) !== 0), tree.resolve(directoryOf(toDir), text(to), { follow: false }));
    },
    symlinkAt(linkTarget, dir, path) { tree.symlink(typeof linkTarget === "string" ? new TextEncoder().encode(linkTarget) : linkTarget, tree.resolve(directoryOf(dir), text(path), { follow: false })); },
    readlinkAt(dir, path) {
      const node = tree.node(target(dir, path, AT_EMPTY_PATH, false)) ?? fail(ENOENT);
      if (node.kind !== "symlink") fail(EINVAL);
      return Uint8Array.from(node.target);
    },
    utimensAt(dir, path, access, modification, flags = 0) {
      if ((flags & ~(AT_SYMLINK_NOFOLLOW | AT_EMPTY_PATH)) !== 0) fail(EINVAL);
      const node = tree.node(target(dir, path, flags, (flags & AT_SYMLINK_NOFOLLOW) === 0)) ?? fail(ENOENT);
      if (node.kind !== "file") return;
      const now = process.now();
      node.file.accessedNs = timeOf(access, node.file.accessedNs, now); node.file.modifiedNs = timeOf(modification, node.file.modifiedNs, now); node.file.changedNs = now;
    },
    pread(fd, count, offset) {
      const { file } = fileOf(fd), start = offsetOf(offset);
      return file.bytes.slice(start, start + count);
    },
    pwrite(fd, bytes, offset) {
      const handle = fileOf(fd);
      if ((handle.flags & O_ACCMODE) === 0) fail(EBADF);
      writeAt(handle, bytes, (handle.flags & O_APPEND) !== 0 ? handle.file.bytes.byteLength : offsetOf(offset), process.now());
      return bytes.byteLength;
    },
    statusFlags(fd) { const own = process.handle(fd); return own === undefined ? (process.streamFlags(fd) ?? fail(EBADF)).get() : own.flags; },
    setStatusFlags(fd, flags) {
      const own = process.handle(fd), changeable = O_APPEND | O_NONBLOCK;
      if (own !== undefined) { own.flags = (own.flags & ~changeable) | (flags & changeable); return; }
      const stream = process.streamFlags(fd) ?? fail(EBADF);
      stream.set((stream.get() & ~changeable) | (flags & changeable));
    },
    getdents(fd, maxBytes) {
      const handle = handleOf(fd);
      if (handle.kind !== "directory") fail(ENOTDIR);
      const names = [".", "..", ...tree.list(handle.path)], records: LinuxDirent[] = [];
      let used = 0;
      for (let index = Number(handle.offset); index < names.length; index++) {
        const name = names[index] ?? "", bytes = new TextEncoder().encode(name);
        if (used + recordLength(bytes) > maxBytes) { if (records.length === 0) fail(EINVAL); break; }
        const path = name === "." ? handle.path : name === ".." ? parentOf(handle.path) : join(handle.path, name), node = tree.node(path) ?? fail(ENOENT);
        records.push({ name: bytes, inode: tree.stat(path, node).inode, type: node.kind === "directory" ? DT_DIR : node.kind === "symlink" ? DT_LNK : DT_REG, next: BigInt(index + 1) });
        used += recordLength(bytes); handle.offset = BigInt(index + 1);
      }
      return records;
    },
    fdatasync(fd) { const handle = process.handle(fd); if (handle === undefined) fail(process.isOpen(fd) ? EINVAL : EBADF); },
    poll(entries, timeoutMs) {
      const ready: LinuxPollReady[] = [];
      for (const entry of entries) {
        const own = process.handle(entry.fd);
        const revents = own === undefined ? process.streamReadiness(entry.fd, entry.events) ?? 32 : entry.events;
        if (revents !== 0) ready.push({ fd: entry.fd, revents });
      }
      if (ready.length > 0 || timeoutMs === 0) return ready;
      if (timeoutMs < 0) throw new VMError("FEATURE_NOT_AVAILABLE", "testHost: a poll without a timeout would wait forever: none of its descriptors can become ready in memory", { reason: "testhost-blocked-poll" });
      process.advance(timeoutMs);
      return ready;
    },
  };
  return Object.freeze(api);
}

/** Writes `bytes` into a file at `at`, zero-filling a gap, and stamps its times. */
export function writeAt(handle: TreeHandle & { readonly kind: "file" }, bytes: Uint8Array, at: number, now: bigint): void {
  const { file } = handle, end = at + bytes.byteLength;
  if (end > file.bytes.byteLength) { const grown = new Uint8Array(end); grown.set(file.bytes); file.bytes = grown; }
  file.bytes.set(bytes, at); file.modifiedNs = now; file.changedNs = now;
}
