import type { LinuxFileStat } from "../../../js-process-types.js";
import { integer } from "../../decode.js";
import { LinuxError, noValue, operation, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import type { LinuxClient } from "../../js-process/transport.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodePath } from "../assistance/node-path.js";
import { createAsyncFiles, createSyncFiles } from "../assistance/node-files.js";
import { createNativeFileService } from "../native-node-api/files.js";
import { linuxErrnoCode } from "../../linux-errno.js";

type Callback<T = unknown> = (error: Error | null, value?: T) => void;

export function goFilesystem(client: LinuxClient, initialCwd: string, failed: (error: unknown) => void) {
  const service = createNativeFileService(client);
  let cwd = initialCwd;
  const fail = (error: unknown, callback: (error: Error) => void): void => {
    if (!(error instanceof LinuxError)) { failed(error); return; }
    callback(Object.assign(error, { code: linuxErrnoCode(error.errno) }));
  };
  const complete = <T>(promise: Promise<T>, callback: Callback<T>): void => {
    void promise.then(value => callback(null, value), (error: unknown) => fail(error, callback)).catch(failed);
  };
  const sync = createSyncFiles(request => service.callSync(request), () => cwd);
  const asynchronous = createAsyncFiles(request => service.call(request), () => cwd, createAsyncContext(), () => () => {});
  const metadata = (stat: LinuxFileStat & { rdev: bigint; blockSize: bigint; blocks: bigint }) => {
    const number = (value: bigint): number => integer(Number(value), "Go file metadata");
    const time = (ns: bigint) => {
      const sec = ns >= 0n ? ns / 1_000_000_000n : (ns - 999_999_999n) / 1_000_000_000n;
      return [String(sec), number(ns - sec * 1_000_000_000n)] as const;
    };
    const [atimeSec, atimeNsec] = time(stat.accessedNs), [mtimeSec, mtimeNsec] = time(stat.modifiedNs), [ctimeSec, ctimeNsec] = time(stat.changedNs);
    return { dev: number(stat.device), ino: String(stat.inode), nlink: number(stat.links), mode: stat.mode, uid: stat.uid, gid: stat.gid,
      rdev: number(stat.rdev), size: number(stat.size), blksize: number(stat.blockSize), blocks: number(stat.blocks),
      atimeSec, atimeNsec, mtimeSec, mtimeNsec, ctimeSec, ctimeNsec, isDirectory: () => (stat.mode & 0o170000) === 0o040000 };
  };
  const position = (offset: string | number): bigint => {
    if (typeof offset === "number") integer(offset, "Go positioned offset");
    const value = BigInt(offset);
    if (value < 0n || value > 0x7fff_ffff_ffff_ffffn) throw new LinuxError(22);
    return value;
  };
  const fs = {
    ...sync, ...asynchronous,
    constants: { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, O_EXCL: 128, O_DIRECTORY: 65536 },
    open(path: string, flags: number, mode: number, callback: Callback<number>): void { complete(client.call(files.open(path, flags, mode)), callback); },
    stat(path: string, callback: Callback): void { complete(client.call(files.stat(path)).then(metadata), callback); },
    lstat(path: string, callback: Callback): void { complete(client.call(files.stat(path, false)).then(metadata), callback); },
    fstat(fd: number, callback: Callback): void { complete(client.call(files.fstat(fd)).then(metadata), callback); },
    read(fd: number, output: Uint8Array, offset: number, length: number, at: string | number | null, callback: Callback<number>): void {
      integer(offset, "Go read offset", 0, output.length); integer(length, "Go read length", 0, output.length - offset);
      const count = Math.min(length, 65536);
      const request = at === null ? files.read(fd, count) : operation(17, new Writer().u64(fd).u64(count).u64(position(at)), result => files.read(fd, count).decode(result));
      complete(client.call(request).then(bytes => { output.set(bytes, offset); return bytes.length; }), callback);
    },
    write(fd: number, input: Uint8Array, offset: number, length: number, at: string | number | null, callback: Callback<number>): void {
      integer(offset, "Go write offset", 0, input.length); integer(length, "Go write length", 0, input.length - offset);
      complete((async () => {
        let written = 0;
        while (written < length) {
          const bytes = input.subarray(offset + written, offset + Math.min(length, written + 65536));
          const request = at === null ? files.write(fd, bytes) : operation(18, new Writer().u64(fd).blob(bytes).u64(position(at) + BigInt(written)), result => files.write(fd, bytes).decode(result));
          const count = await client.call(request); written += count;
          if (count !== bytes.length) break;
        }
        return written;
      })(), callback);
    },
    lseek(fd: number, offset: string, whence: number, callback: Callback<string>): void {
      const origin = (["start", "current", "end"] as const)[integer(whence, "Go seek origin", 0, 2)];
      complete(client.call(files.seek(fd, BigInt(offset), origin)).then(value => String(value)), callback);
    },
    chown(_path: string, _uid: number, _gid: number, callback: Callback): void { fail(new LinuxError(38), callback); },
    lchown(_path: string, _uid: number, _gid: number, callback: Callback): void { fail(new LinuxError(38), callback); },
    fchown(_fd: number, _uid: number, _gid: number, callback: Callback): void { fail(new LinuxError(38), callback); },
    utimes(_path: string, _access: number, _modified: number, callback: Callback): void { fail(new LinuxError(38), callback); },
  };
  return { fs, path: createNodePath(() => cwd), cwd: () => cwd, chdir(path: string): void {
    client.sync(operation(80, new Writer().path(path), noValue));
    cwd = client.sync(operation(79, new Writer(), result => new TextDecoder().decode(result.bytes.subarray(0, -1))));
  } };
}
