// A recording, tree-backed stand-in for the files.at port and the file members of files.sync, for adapter unit tests.
// It resolves paths lexically (no symlink following) and records every call with its exact flags, so tests assert
// what the adapter asks of the host; Linux semantics themselves are checked against the real engine in test/browser.
import type { FileDescriptor, LinuxFileStat } from "../../../js-process-types.js";
import type { AtFiles, LinuxDirent } from "./host.js";
import { descriptor, FakeLinuxError } from "./streams.test-support.js";

type Node = { mode: number; data: Uint8Array; target?: Uint8Array; atime: bigint; mtime: bigint };
type Open = { path: string; offset: bigint; flags: number };
export interface Call { readonly op: string; readonly args: readonly unknown[] }

const text = (path: string | Uint8Array) => typeof path === "string" ? path : new TextDecoder().decode(path);
function join(base: string, path: string): string {
  const parts = (path.startsWith("/") ? path : `${base}/${path}`).split("/");
  const out: string[] = [];
  for (const part of parts) { if (part === "" || part === ".") continue; if (part === "..") out.pop(); else out.push(part); }
  return `/${out.join("/")}`;
}
function isAtFdcwd(value: number): value is FileDescriptor { return value === -100; }
function atFdcwd(): FileDescriptor { const value = -100; if (!isAtFdcwd(value)) throw new RangeError("AT_FDCWD"); return value; }
const parentOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));

export class FakeFiles {
  readonly calls: Call[] = [];
  readonly tree = new Map<string, Node>([["/", { mode: 0o040755, data: new Uint8Array(), atime: 0n, mtime: 0n }]]);
  readonly open = new Map<number, Open>();
  #next = 10;

  constructor(files: Readonly<Record<string, string>> = {}, directories: readonly string[] = []) {
    for (const directory of directories) this.tree.set(directory, { mode: 0o040755, data: new Uint8Array(), atime: 0n, mtime: 0n });
    for (const [path, content] of Object.entries(files)) this.tree.set(path, { mode: 0o100644, data: new TextEncoder().encode(content), atime: 0n, mtime: 0n });
  }

  owns(fd: number): boolean { return this.open.has(fd); }
  #path(dir: FileDescriptor, path: string | Uint8Array): string {
    const base = dir === -100 ? "/workspace" : this.open.get(dir)?.path;
    if (base === undefined) throw new FakeLinuxError(9);
    return text(path) === "" ? base : join(base, text(path));
  }
  #node(path: string): Node { const node = this.tree.get(path); if (node === undefined) throw new FakeLinuxError(2); return node; }
  stat(path: string): LinuxFileStat {
    const node = this.#node(path);
    return { device: 1n, inode: BigInt([...this.tree.keys()].indexOf(path) + 1), links: 1n, mode: node.mode, uid: 1000, gid: 1000, size: BigInt(node.data.byteLength), accessedNs: node.atime, modifiedNs: node.mtime, changedNs: node.mtime };
  }
  fileOf(fd: number): Open { const open = this.open.get(fd); if (open === undefined) throw new FakeLinuxError(9); return open; }
  read(fd: number, count: number): Uint8Array {
    const open = this.fileOf(fd), node = this.#node(open.path);
    const chunk = node.data.slice(Number(open.offset), Number(open.offset) + count); open.offset += BigInt(chunk.byteLength); return chunk;
  }
  write(fd: number, bytes: Uint8Array): number {
    const open = this.fileOf(fd), node = this.#node(open.path);
    const at = (open.flags & 0o2000) !== 0 ? node.data.byteLength : Number(open.offset);
    const grown = new Uint8Array(Math.max(node.data.byteLength, at + bytes.byteLength)); grown.set(node.data); grown.set(bytes, at);
    node.data = grown; open.offset = BigInt(at + bytes.byteLength); return bytes.byteLength;
  }
  seek(fd: number, offset: bigint, origin: "start" | "current" | "end"): bigint {
    const open = this.fileOf(fd);
    open.offset = origin === "start" ? offset : origin === "current" ? open.offset + offset : BigInt(this.#node(open.path).data.byteLength) + offset;
    this.calls.push({ op: "seek", args: [fd, offset, origin] });
    return open.offset;
  }
  truncate(fd: number, length: bigint): void {
    const node = this.#node(this.fileOf(fd).path), data = new Uint8Array(Number(length));
    data.set(node.data.subarray(0, Number(length))); node.data = data; this.calls.push({ op: "ftruncate", args: [fd, length] });
  }
  close(fd: number): void { this.fileOf(fd); this.open.delete(fd); this.calls.push({ op: "close", args: [fd] }); }

  readonly at: AtFiles = {
    cwd: atFdcwd(),
    openat: (dir, path, flags, mode, resolve = 0) => {
      this.calls.push({ op: "openat", args: [dir, text(path), flags, mode, resolve] });
      const target = this.#path(dir, path);
      if (!this.tree.has(target)) {
        if ((flags & 0o100) === 0) throw new FakeLinuxError(2);
        this.tree.set(target, { mode: 0o100644, data: new Uint8Array(), atime: 0n, mtime: 0n });
      } else if ((flags & 0o300) === 0o300) throw new FakeLinuxError(17);
      const node = this.#node(target);
      if ((flags & 0o200000) !== 0 && (node.mode & 0o170000) !== 0o040000) throw new FakeLinuxError(20);
      if ((flags & 0o1000) !== 0) node.data = new Uint8Array();
      const fd = this.#next++; this.open.set(fd, { path: target, offset: 0n, flags }); return descriptor(fd);
    },
    statAt: (dir, path, flags = 0) => { this.calls.push({ op: "statAt", args: [dir, text(path), flags] }); return this.stat(this.#path(dir, path)); },
    mkdirAt: (dir, path, mode) => {
      this.calls.push({ op: "mkdirAt", args: [dir, text(path), mode] });
      const target = this.#path(dir, path);
      if (this.tree.has(target)) throw new FakeLinuxError(17);
      this.#node(parentOf(target));
      this.tree.set(target, { mode: 0o040755, data: new Uint8Array(), atime: 0n, mtime: 0n });
    },
    unlinkAt: (dir, path, flags = 0) => {
      this.calls.push({ op: "unlinkAt", args: [dir, text(path), flags] });
      const target = this.#path(dir, path), node = this.#node(target), isDir = (node.mode & 0o170000) === 0o040000;
      if (isDir && (flags & 0x200) === 0) throw new FakeLinuxError(21);
      if (!isDir && (flags & 0x200) !== 0) throw new FakeLinuxError(20);
      if (isDir && [...this.tree.keys()].some(key => key.startsWith(`${target}/`))) throw new FakeLinuxError(39);
      this.tree.delete(target);
    },
    renameAt: (fromDir, from, toDir, to, flags = 0) => {
      this.calls.push({ op: "renameAt", args: [fromDir, text(from), toDir, text(to), flags] });
      const source = this.#path(fromDir, from), target = this.#path(toDir, to);
      for (const [key, node] of [...this.tree]) if (key === source || key.startsWith(`${source}/`)) { this.tree.delete(key); this.tree.set(target + key.slice(source.length), node); }
      for (const open of this.open.values()) if (open.path === source || open.path.startsWith(`${source}/`)) open.path = target + open.path.slice(source.length);
    },
    linkAt: (fromDir, from, toDir, to, flags = 0) => { this.calls.push({ op: "linkAt", args: [fromDir, text(from), toDir, text(to), flags] }); this.tree.set(this.#path(toDir, to), this.#node(this.#path(fromDir, from))); },
    symlinkAt: (target, dir, path) => { this.calls.push({ op: "symlinkAt", args: [text(target), dir, text(path)] }); this.tree.set(this.#path(dir, path), { mode: 0o120777, data: new Uint8Array(), target: typeof target === "string" ? new TextEncoder().encode(target) : target, atime: 0n, mtime: 0n }); },
    readlinkAt: (dir, path) => { this.calls.push({ op: "readlinkAt", args: [dir, text(path)] }); const node = this.#node(this.#path(dir, path)); if (node.target === undefined) throw new FakeLinuxError(22); return node.target; },
    utimensAt: (dir, path, access, modification, flags = 0) => {
      this.calls.push({ op: "utimensAt", args: [dir, text(path), access, modification, flags] });
      const node = this.#node(this.#path(dir, path));
      if (typeof access === "bigint") node.atime = access; if (typeof modification === "bigint") node.mtime = modification;
    },
    pread: (fd, count, offset) => { this.calls.push({ op: "pread", args: [fd, count, offset] }); const node = this.#node(this.fileOf(fd).path); return node.data.slice(Number(offset), Number(offset) + count); },
    pwrite: (fd, bytes, offset) => {
      this.calls.push({ op: "pwrite", args: [fd, bytes.byteLength, offset] });
      const node = this.#node(this.fileOf(fd).path), at = Number(offset);
      const grown = new Uint8Array(Math.max(node.data.byteLength, at + bytes.byteLength)); grown.set(node.data); grown.set(bytes, at); node.data = grown;
      return bytes.byteLength;
    },
    statusFlags: fd => this.fileOf(fd).flags & 0o4012000,
    setStatusFlags: (fd, flags) => { this.calls.push({ op: "setStatusFlags", args: [fd, flags] }); const open = this.fileOf(fd); open.flags = (open.flags & ~0o6000) | (flags & 0o6000); },
    getdents: (fd, maxBytes) => {
      this.calls.push({ op: "getdents", args: [fd, maxBytes] });
      const open = this.fileOf(fd), prefix = open.path === "/" ? "/" : `${open.path}/`;
      const names = [".", "..", ...[...this.tree.keys()].filter(key => key.startsWith(prefix) && key !== open.path && !key.slice(prefix.length).includes("/")).map(key => key.slice(prefix.length)).sort()];
      const start = Number(open.offset), batch: LinuxDirent[] = names.slice(start).map((name, index) => {
        const path = name === "." ? open.path : name === ".." ? parentOf(open.path) : prefix + name, mode = this.tree.get(path)?.mode ?? 0o040755;
        return { name: new TextEncoder().encode(name), inode: BigInt(index + start + 1), type: (mode & 0o170000) === 0o040000 ? 4 : (mode & 0o170000) === 0o120000 ? 10 : 8, next: BigInt(start + index + 1) };
      });
      open.offset = BigInt(names.length);
      return batch;
    },
    fdatasync: fd => { this.calls.push({ op: "fdatasync", args: [fd] }); this.fileOf(fd); },
    poll: () => [],
  };
}
