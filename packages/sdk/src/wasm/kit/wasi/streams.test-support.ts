// A typed stand-in for the host members kit.wasi uses: three standard streams with an optional pipe capacity (so writes
// can be partial), Linux errors as the SDK's LinuxError, `fail` writing its message to standard error, and the optional
// files.at / clock / random / process / net members. It models only what the kit calls.
import type { ClockHost, FileDescriptor, LinuxFileStat, LinuxProcessInfo, LinuxSyncFiles, RandomHost } from "../../../js-process-types.js";
import { LinuxError } from "../../../runtime/js-process/codec.js";
import type { FakeFiles } from "./files.test-support.js";
import type { WasiRunHost } from "./host.js";

type ProcessId = LinuxProcessInfo["pid"];

/** A Linux failure as the SDK raises it, so the kit's errno mapping sees exactly what production code sees. */
export class FakeLinuxError extends LinuxError {}

function isDescriptor(value: number): value is FileDescriptor { return Number.isInteger(value) && value >= 0; }
function isProcessId(value: number): value is ProcessId { return Number.isInteger(value) && value > 0; }
function processId(value: number): ProcessId { if (!isProcessId(value)) throw new RangeError(`not a pid: ${String(value)}`); return value; }
export function descriptor(value: number): FileDescriptor {
  if (!isDescriptor(value)) throw new RangeError(`not a descriptor: ${String(value)}`);
  return value;
}

export interface StreamsOptions {
  /** Files behind files.at and the file members of files.sync; absent, as for a module without files.at. */
  readonly files?: FakeFiles;
  readonly clock?: ClockHost;
  readonly random?: RandomHost;
  readonly process?: WasiRunHost["process"];
  readonly net?: WasiRunHost["net"];
  /** Files `fs.open` serves for reading (program files). */
  readonly programs?: Readonly<Record<string, Uint8Array>>;
  /** The mode fstat reports for every stream (default a FIFO). */
  readonly mode?: number;
  readonly stdin?: Uint8Array;
  /** The most bytes one write to stdout accepts; a smaller value forces partial writes. */
  readonly stdoutCapacity?: number;
  /** stdout's reader has gone: writes fail with EPIPE (32), as when SIGPIPE is ignored. */
  readonly stdoutClosed?: boolean;
}

export type StreamsHost = WasiRunHost & { readonly fs: WasiRunHost["fs"] & Pick<LinuxSyncFiles, "open"> };
export interface Streams {
  readonly host: StreamsHost;
  readonly stdout: () => Uint8Array;
  readonly stderr: () => string;
  readonly writes: () => readonly number[];
}

/** The identity `process.info` reports in these tests. */
export const TEST_IDENTITY: LinuxProcessInfo = { pid: processId(42), parentPid: processId(7), uid: 1000, gid: 1000, cwd: "/workspace", args: [], environment: [], terminal: null };

export function streams(options: StreamsOptions = {}): Streams {
  let input = options.stdin ?? new Uint8Array();
  const output: [Uint8Array[], Uint8Array[]] = [[], []], counts: number[] = [];
  const programs = new Map<number, { readonly bytes: Uint8Array; offset: number }>();
  const stat = (mode: number): LinuxFileStat => ({ device: 0n, inode: 1n, links: 1n, mode, uid: 1000, gid: 1000, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n });
  const files = options.files;
  const host: StreamsHost = {
    fail(status, message) { output[1].push(new TextEncoder().encode(`${message}\n`)); return status; },
    fs: {
      read(fd, count) {
        if (files?.owns(fd) === true) return files.read(fd, count);
        const program = programs.get(fd);
        if (program !== undefined) { const chunk = program.bytes.subarray(program.offset, program.offset + count); program.offset += chunk.byteLength; return chunk; }
        if (fd !== 0) throw new FakeLinuxError(9);
        const chunk = input.slice(0, count); input = input.slice(chunk.byteLength); return chunk;
      },
      write(fd, bytes) {
        if (files?.owns(fd) === true) return files.write(fd, bytes);
        if (fd !== 1 && fd !== 2) throw new FakeLinuxError(9);
        if (fd === 1 && options.stdoutClosed === true) throw new FakeLinuxError(32);
        const accepted = fd === 1 ? bytes.subarray(0, options.stdoutCapacity ?? bytes.byteLength) : bytes;
        output[fd - 1]?.push(accepted.slice()); counts.push(accepted.byteLength);
        return accepted.byteLength;
      },
      fstat: fd => files?.owns(fd) === true ? files.stat(files.fileOf(fd).path) : stat(options.mode ?? 0o010600),
      seek: (fd, offset, origin = "start") => { if (files?.owns(fd) === true) return files.seek(fd, offset, origin); throw new FakeLinuxError(29); },
      close: fd => { if (files?.owns(fd) === true) files.close(fd); programs.delete(fd); },
      fsync: () => undefined,
      pipe: () => { throw new FakeLinuxError(24); },
      open: path => {
        const bytes = options.programs?.[typeof path === "string" ? path : new TextDecoder().decode(path)];
        if (bytes === undefined) throw new FakeLinuxError(2);
        const fd = 500 + programs.size; programs.set(fd, { bytes, offset: 0 }); return descriptor(fd);
      },
      ftruncate: (fd, length) => { if (files?.owns(fd) === true) { files.truncate(fd, BigInt(length)); return; } throw new FakeLinuxError(22); },
    },
    ...(files === undefined ? {} : { at: files.at }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.random === undefined ? {} : { random: options.random }),
    process: options.process ?? { info: () => Promise.resolve(TEST_IDENTITY) },
    ...(options.net === undefined ? {} : { net: options.net }),
  };
  const join = (parts: readonly Uint8Array[]): Uint8Array => {
    const all = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0)); let at = 0;
    for (const part of parts) { all.set(part, at); at += part.byteLength; }
    return all;
  };
  return { host, stdout: () => join(output[0]), stderr: () => new TextDecoder().decode(join(output[1])), writes: () => counts };
}
