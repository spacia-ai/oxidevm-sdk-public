import { LinuxError, noValue, operation, protocol, value, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { decodeSpawn, searchPathOperation, spawnPayload } from "../../js-process/process.js";
import { VMError } from "../../errors.js";
import type { LinuxClient } from "../../js-process/transport.js";
import type { CapturedProcess, ProcessRuntimeIO } from "../assistance/process-io.js";

export class NativeChildLaunchFailure extends LinuxError {
  constructor(error: LinuxError, readonly stage: "path-search" | "spawn") { super(error.errno); this.cause = error; }
}

function launch<T>(run: () => T, stage: NativeChildLaunchFailure["stage"]): T {
  try { return run(); }
  catch (error) { if (error instanceof LinuxError) throw new NativeChildLaunchFailure(error, stage); throw error; }
}

/** Only the caller's worker blocks. Rust schedules the child and owns readiness and reaping. */
export function captureNativeChild(client: Pick<LinuxClient, "sync">, ...[input, bytes, maxBuffer, options]: Parameters<NonNullable<ProcessRuntimeIO["captureSync"]>>): CapturedProcess {
  const path = options?.path, bun = options?.runtime === "bun";
  const command = path === undefined ? input.command : launch(() => client.sync(searchPathOperation(input.command, path)), "path-search");
  const child = launch(() => client.sync(operation(65538, spawnPayload({ command, args: input.args, cwd: input.cwd, env: input.env,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } }, false, path === undefined ? undefined : { kind: "selected", argv0: input.command }), decodeSpawn)), "spawn");
  const open = new Set<number>([child.stdin, child.stdout, child.stderr].filter(fd => fd !== null));
  const streams = [child.stdout, child.stderr].map(fd => ({ fd, size: 0, chunks: [] as Uint8Array[] }));
  let stdin = child.stdin, offset = 0, reaped = false, exceeded = false;
  const close = (fd: number): void => { client.sync(files.close(fd)); open.delete(fd); };
  const signal = (number: number): void => { client.sync(operation(62, new Writer().u32(child.pid).u8(number), noValue)); };
  try {
    for (const fd of open) client.sync(files.statusFlags(fd, client.sync(files.statusFlags(fd)) | 2048));
    while (open.size !== 0) {
      if (stdin !== null && (offset === bytes.byteLength || exceeded)) { close(stdin); stdin = null; }
      const entries: { fd: number; events: 1 | 4; stream?: typeof streams[number] }[] = [];
      if (stdin !== null) entries.push({ fd: stdin, events: 4 });
      for (const stream of streams) if (stream.fd !== null && open.has(stream.fd)) entries.push({ fd: stream.fd, events: 1, stream });
      if (entries.length === 0) break;
      const ready = client.sync(files.pollPipes(entries));
      for (const event of ready) {
        if (event.revents === 0) continue;
        const entry = entries.find(entry => entry.fd === event.fd);
        if (entry === undefined) protocol("Unknown synchronous child pipe");
        try {
          if (entry.stream === undefined) {
            const written = client.sync(files.write(entry.fd, bytes.subarray(offset, offset + 65536)));
            if (written === 0) protocol("Synchronous child input made no progress");
            offset += written;
          } else {
            const chunk = client.sync(files.read(entry.fd, 65536));
            if (chunk.byteLength === 0) { close(entry.fd); continue; }
            // shortcut: Bun spill is limited to 64 MiB plus one read per stream; qualify larger spills before expanding it.
            if (entry.stream.size + chunk.byteLength > 64 * 1024 * 1024 + 65536) throw new VMError("QUOTA_EXCEEDED", "Synchronous child capture exceeds its memory capacity");
            entry.stream.chunks.push(chunk);
            entry.stream.size += chunk.byteLength;
            const size = bun ? entry.stream.size : streams.reduce((total, stream) => total + stream.size, 0);
            if (size > maxBuffer && !exceeded) {
              exceeded = true;
              try { signal(15); } catch (error) { if (!(error instanceof LinuxError) || error.errno !== 3) throw error; }
              if (!bun) {
                for (const fd of open) close(fd);
                stdin = null;
                break;
              }
            }
          }
        } catch (error) {
          if (!(error instanceof LinuxError)) throw error;
          if (error.errno === 11 || error.errno === 4) continue;
          if (error.errno === 32 && entry.stream === undefined) { close(entry.fd); stdin = null; continue; }
          throw error;
        }
      }
    }
    const status = client.sync(operation(61, new Writer().u32(child.pid), value));
    reaped = true;
    if (status > 0xffff) protocol("Invalid synchronous child exit status");
    const output = streams.map(stream => {
      const bytes = new Uint8Array(stream.size); let offset = 0;
      for (const chunk of stream.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    });
    const stdout = output[0], stderr = output[1];
    if (stdout === undefined || stderr === undefined) protocol("Missing synchronous child output");
    return { pid: child.pid, status: (status & 0x7f) === 0 ? status >> 8 : null, signal: (status & 0x7f) === 0 ? null : status & 0x7f,
      stdout, stderr, ...(exceeded ? { error: "ENOBUFS" as const } : {}) };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Synchronous child failed", { cause: error });
    const failures = [failure];
    const cleanup = (run: () => void, ignored: number): void => {
      try { run(); } catch (error) { if (!(error instanceof LinuxError) || error.errno !== ignored) failures.push(error instanceof Error ? error : new Error("Synchronous child cleanup failed", { cause: error })); }
    };
    // Closing all pipe ends also releases backpressure after a transport failure.
    for (const fd of open) cleanup(() => { close(fd); }, 9);
    if (!reaped) {
      cleanup(() => { signal(9); }, 3);
      cleanup(() => { client.sync(operation(61, new Writer().u32(child.pid), value)); }, 10);
    }
    if (failures.length > 1) throw new AggregateError(failures, "Synchronous child capture and cleanup failed", { cause: error });
    throw failure;
  }
}
