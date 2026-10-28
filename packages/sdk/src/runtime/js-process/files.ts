import type { LinuxDirectoryEntry, LinuxFiles, LinuxPath, LinuxSyncFiles } from "../../js-process-types.js";
import { JS_MAX_IO_BYTES, LinuxError, viewBytes, writeBytes } from "./codec.js";
import { files } from "./file-operations.js";
import type { LinuxClient } from "./transport.js";
import { integer } from "../decode.js";

const Uint8Array = globalThis.Uint8Array;
function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> { const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { writeBytes(result, chunk, offset); offset += chunk.byteLength; } return result; }
function maximum(value: number): number { return integer(value, "readFile limit", 0, JS_MAX_IO_BYTES); }
function visible(entry: LinuxDirectoryEntry): boolean { return entry.name !== "." && entry.name !== ".."; }

export function syncFiles(client: LinuxClient): LinuxSyncFiles {
  const call = client.sync.bind(client);
  const api: LinuxSyncFiles = {
    open: (path, flags, mode) => call(files.open(path, flags, mode)),
    read: (fd, count) => call(files.read(fd, count)), write: (fd, bytes) => call(files.write(fd, bytes)),
    seek: (fd, offset, origin) => call(files.seek(fd, offset, origin)), close: fd => call(files.close(fd)),
    dup: (fd, target) => call(files.dup(fd, target)), pipe: () => call(files.pipe()),
    stat: path => call(files.stat(path)), lstat: path => call(files.stat(path, false)), fstat: fd => call(files.fstat(fd)),
    realpath: path => call(files.realpath(path)), mkdir: (path, mode) => call(files.mkdir(path, mode)),
    rename: (from, to) => call(files.rename(from, to)), unlink: (path, directory) => call(files.unlink(path, directory)), fsync: fd => call(files.fsync(fd)),
    readdir(path) {
      const fd = api.open(path, 0x1_0000), entries: LinuxDirectoryEntry[] = [];
      try { for (;;) { const next = call(files.getdents(fd)); if (next.length === 0) return entries; entries.push(...next.filter(visible)); } }
      finally { api.close(fd); }
    },
    readFile(path: LinuxPath, maxBytes = JS_MAX_IO_BYTES) {
      maximum(maxBytes); const fd = api.open(path), chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const bytes = api.read(fd, Math.min(256 * 1024, maxBytes - total + 1)); if (bytes.byteLength === 0) return concatenate(chunks, total); total += bytes.byteLength; if (total > maxBytes) throw new LinuxError(27); chunks.push(bytes); } }
      finally { api.close(fd); }
    },
    writeFile(path, bytes) { const fd = api.open(path, 0o1101); try { api.writeAll(fd, bytes); } finally { api.close(fd); } },
    writeAll(fd, bytes) { let offset = 0; while (offset < bytes.byteLength) { const count = api.write(fd, viewBytes(bytes, offset, offset + 64 * 1024)); if (count === 0) throw new LinuxError(5); offset += count; } },
  };
  return api;
}

export function asyncFiles(client: LinuxClient): LinuxFiles {
  const call = client.call.bind(client);
  const api: LinuxFiles = {
    open: (path, flags, mode, options) => call(files.open(path, flags, mode), options?.signal),
    read: (fd, count, options) => call(files.read(fd, count), options?.signal), write: (fd, bytes, options) => call(files.write(fd, bytes), options?.signal),
    seek: (fd, offset, origin) => call(files.seek(fd, offset, origin)), close: fd => call(files.close(fd)),
    dup: (fd, target) => call(files.dup(fd, target)), pipe: () => call(files.pipe()),
    stat: path => call(files.stat(path)), lstat: path => call(files.stat(path, false)), fstat: fd => call(files.fstat(fd)),
    realpath: path => call(files.realpath(path)), mkdir: (path, mode) => call(files.mkdir(path, mode)),
    rename: (from, to) => call(files.rename(from, to)), unlink: (path, directory) => call(files.unlink(path, directory)), fsync: fd => call(files.fsync(fd)),
    async readdir(path) {
      const fd = await api.open(path, 0x1_0000), entries: LinuxDirectoryEntry[] = [];
      try { for (;;) { const next = await call(files.getdents(fd)); if (next.length === 0) return entries; entries.push(...next.filter(visible)); } }
      finally { await api.close(fd); }
    },
    async readFile(path, maxBytes = JS_MAX_IO_BYTES) {
      maximum(maxBytes); const fd = await api.open(path), chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const bytes = await api.read(fd, Math.min(256 * 1024, maxBytes - total + 1)); if (bytes.byteLength === 0) return concatenate(chunks, total); total += bytes.byteLength; if (total > maxBytes) throw new LinuxError(27); chunks.push(bytes); } }
      finally { await api.close(fd); }
    },
    async writeFile(path, bytes) { const fd = await api.open(path, 0o1101); try { await api.writeAll(fd, bytes); } finally { await api.close(fd); } },
    async writeAll(fd, bytes, options) { let offset = 0; while (offset < bytes.byteLength) { const count = await api.write(fd, viewBytes(bytes, offset, offset + 64 * 1024), options); if (count === 0) throw new LinuxError(5); offset += count; } },
  };
  return api;
}
