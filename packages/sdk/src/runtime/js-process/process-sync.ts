import type { FileDescriptor, LinuxPollRequest, NativeSyncRunResult, NativeSyncRunSpec, ProcessSync } from "../../js-process-types.js";
import { VMError } from "../errors.js";
import { atFileOperations } from "./at-operations.js";
import { clockOperations } from "./clock-random.js";
import { LinuxError, protocol, writeBytes } from "./codec.js";
import { files } from "./file-operations.js";
import { processOperations } from "./process.js";
import type { LinuxClient } from "./transport.js";

/** The bounds `runSync` holds a run to. */
export const RUN_SYNC_LIMITS = { arguments: 64, inputBytes: 5 * 1024 ** 2, timeoutMs: 180_000, outputBytes: 1024 ** 2 } as const;

const O_NONBLOCK = 0x800, POLLERR = 8, SIGKILL = 9;
const POLLIN: LinuxPollRequest["events"] = 1, POLLOUT: LinuxPollRequest["events"] = 4;
const EAGAIN = 11, EINTR = 4, EPIPE = 32, E2BIG = 7, ETIMEDOUT = 110;
const CHUNK = 64 * 1024, NS_PER_MS = 1_000_000n;

function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", message, { reason: "process-run-sync" }); }
const isText = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
function bounded(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  return value;
}

interface ValidRun {
  readonly command: string; readonly args: readonly string[]; readonly cwd: string | undefined; readonly env: Readonly<Record<string, string>> | undefined;
  readonly input: Uint8Array; readonly timeoutMs: number; readonly stdoutLimit: number; readonly stderrLimit: number;
}
/** Every bound of a run, checked before anything is spawned. */
function validate(spec: NativeSyncRunSpec): ValidRun {
  const { command, args = [], cwd, env, input = new Uint8Array() } = spec;
  if (!isText(command) || !command.startsWith("/")) invalid("runSync takes an absolute command path without NUL");
  if (!Array.isArray(args) || args.length + 1 > RUN_SYNC_LIMITS.arguments || !args.every(isText)) invalid(`runSync takes 1 to ${String(RUN_SYNC_LIMITS.arguments)} arguments without NUL, the command included`);
  if (cwd !== undefined && !isText(cwd)) invalid("A runSync directory must be a path without NUL");
  if (env !== undefined && (typeof env !== "object" || Object.entries(env).some(([key, entry]) => key === "" || key.includes("=") || !isText(key) || !isText(entry)))) invalid("runSync environment names must be non-empty without = or NUL, and values without NUL");
  if (!(input instanceof Uint8Array) || input.byteLength > RUN_SYNC_LIMITS.inputBytes) invalid("runSync input must be a Uint8Array of at most 5 MiB");
  return {
    command, args, cwd, env, input,
    timeoutMs: bounded(spec.timeoutMs, "A runSync timeout", 1, RUN_SYNC_LIMITS.timeoutMs),
    stdoutLimit: bounded(spec.stdoutLimit, "A runSync stdout limit", 0, RUN_SYNC_LIMITS.outputBytes),
    stderrLimit: bounded(spec.stderrLimit, "A runSync stderr limit", 0, RUN_SYNC_LIMITS.outputBytes),
  };
}

interface Output { readonly fd: FileDescriptor; readonly limit: number; readonly chunks: Uint8Array[]; size: number }
function joined(output: Output): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(output.size); let offset = 0;
  for (const chunk of output.chunks) { writeBytes(bytes, chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
const retry = (error: unknown): boolean => error instanceof LinuxError && (error.errno === EAGAIN || error.errno === EINTR);

/**
 * Runs an owned child with piped standard streams to completion on this worker's synchronous channel. One loop feeds
 * input and drains both outputs through Rust's timed readiness (OXJR 65552), so a child that fills a pipe while it waits
 * for input cannot deadlock, and every wait is bounded by what remains of the deadline on the VM's monotonic clock: no
 * timer runs on the blocked worker, and a descendant that keeps a pipe open cannot hold the run past its deadline. On
 * timeout, a limit or any failure the child is killed and reaped before the error reaches the caller.
 */
export function runSync(client: Pick<LinuxClient, "sync">, spec: NativeSyncRunSpec): NativeSyncRunResult {
  const run = validate(spec);
  const request = processOperations.spawn({
    command: run.command, args: run.args, ...(run.cwd === undefined ? {} : { cwd: run.cwd }), ...(run.env === undefined ? {} : { env: run.env }),
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  }, true);
  const monotonic = (): bigint => client.sync(clockOperations.now("monotonic"));
  const deadline = monotonic() + BigInt(run.timeoutMs) * NS_PER_MS;
  const child = client.sync(request);
  const open = new Set<FileDescriptor>([child.stdin, child.stdout, child.stderr].filter(fd => fd !== null));
  const close = (fd: FileDescriptor): void => { if (open.delete(fd)) client.sync(files.close(fd)); };
  let reaped = false;
  try {
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null || open.size !== 3) protocol("The native child did not provide its requested pipes");
    for (const fd of open) client.sync(atFileOperations.setStatusFlags(fd, client.sync(atFileOperations.statusFlags(fd)) | O_NONBLOCK));
    const outputs: readonly Output[] = [{ fd: stdout, limit: run.stdoutLimit, chunks: [], size: 0 }, { fd: stderr, limit: run.stderrLimit, chunks: [], size: 0 }];
    // The input end while input remains, held in a record so every closure and loop pass reads its current state.
    const feed: { fd: FileDescriptor | null; offset: number } = { fd: stdin, offset: 0 };
    const stopFeeding = (): void => { if (feed.fd !== null) close(feed.fd); feed.fd = null; };
    if (run.input.byteLength === 0) stopFeeding();
    for (;;) {
      const reading = outputs.filter(output => open.has(output.fd));
      if (reading.length === 0) break;
      const now = monotonic();
      if (now >= deadline) throw new LinuxError(ETIMEDOUT);
      const remaining = Number((deadline - now + NS_PER_MS - 1n) / NS_PER_MS);
      const entries: LinuxPollRequest[] = reading.map(output => ({ fd: output.fd, events: POLLIN }));
      if (feed.fd !== null) entries.unshift({ fd: feed.fd, events: POLLOUT });
      for (const event of client.sync(atFileOperations.poll(entries, remaining))) {
        const feeding = feed.fd;
        if (feeding !== null && event.fd === feeding) {
          // A pipe with no reader polls POLLERR: stop feeding instead of writing into it (EPIPE, SIGPIPE).
          if ((event.revents & POLLERR) !== 0) { stopFeeding(); continue; }
          try { feed.offset += client.sync(files.write(feeding, run.input.subarray(feed.offset, feed.offset + CHUNK))); }
          catch (error: unknown) { if (error instanceof LinuxError && error.errno === EPIPE) { stopFeeding(); continue; } if (!retry(error)) throw error; }
          if (feed.offset === run.input.byteLength) stopFeeding();
          continue;
        }
        const output = outputs.find(candidate => candidate.fd === event.fd);
        if (output === undefined) protocol("Readiness for an unknown child pipe");
        let chunk: Uint8Array;
        try { chunk = client.sync(files.read(output.fd, Math.min(CHUNK, output.limit - output.size + 1))); }
        catch (error: unknown) { if (retry(error)) continue; throw error; }
        if (chunk.byteLength === 0) { close(output.fd); continue; }
        output.size += chunk.byteLength;
        if (output.size > output.limit) throw new LinuxError(E2BIG);
        output.chunks.push(chunk);
      }
    }
    stopFeeding();
    const exit = client.sync(processOperations.wait(child.pid));
    reaped = true;
    const [out, err] = outputs;
    if (out === undefined || err === undefined) protocol("Missing native child output");
    return { pid: child.pid, exit, stdout: joined(out), stderr: joined(err) };
  } finally {
    for (const fd of [...open]) { try { close(fd); } catch { /* the pipe end is already gone */ } }
    if (!reaped) {
      try { client.sync(processOperations.signal(child.pid, SIGKILL)); } catch { /* it already exited */ }
      try { client.sync(processOperations.wait(child.pid)); } catch { /* already reaped */ }
    }
  }
}

/** `host.process`'s synchronous calls (capability `process.sync`) on this process's own Linux channel. */
export function processSync(client: Pick<LinuxClient, "sync">): ProcessSync {
  return Object.freeze({
    infoSync: () => client.sync(processOperations.info()),
    spawnSync: spec => client.sync(processOperations.spawn(spec, spec.owned === true)),
    waitSync: pid => client.sync(processOperations.wait(pid)),
    signalSync: (pid, signal) => { client.sync(processOperations.signal(pid, signal)); },
    runSync: spec => runSync(client, spec),
  } satisfies ProcessSync);
}
