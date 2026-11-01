import { afterEach, expect, it, vi } from "vitest";
import type { FileDescriptor, NativeChildSpec } from "../../js-process-types.js";
import type { ProcessExit } from "../../contracts.js";
import { descriptor } from "../../runtime/js-process/codec.js";
import { knownLinuxSignal } from "../../runtime/process-signals.js";
import { decodeProcessId } from "../../values.js";
import { runNative, type NativeRunHost, type NativeRunRequest } from "./native-run.js";

afterEach(() => { vi.useRealTimers(); });

const stdin = descriptor(10), stdout = descriptor(11), stderr = descriptor(12);
const pid = decodeProcessId(7);
const encoder = new TextEncoder();

interface Script {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  /** Reads block until the run is aborted, and the child exits only after it is killed. */
  readonly hang?: boolean;
  readonly exit?: ProcessExit;
  readonly pipes?: "all" | "missing";
}

function fakeHost(script: Script = {}) {
  const calls = { spawned: [] as NativeChildSpec[], signals: [] as (readonly [number, number])[], written: [] as string[], closed: [] as FileDescriptor[] };
  const killed = Promise.withResolvers<undefined>();
  const queues = new Map<FileDescriptor, Uint8Array[]>([[stdout, (script.stdout ?? []).map(text => encoder.encode(text))], [stderr, (script.stderr ?? []).map(text => encoder.encode(text))]]);
  const files = {
    read(fd, _count, options) {
      const next = queues.get(fd)?.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (script.hang !== true) return Promise.resolve(new Uint8Array());
      const signal = options?.signal;
      const failure = () => (signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal?.aborted === true) return Promise.reject(failure());
      return new Promise<Uint8Array>((_resolve, reject) => { signal?.addEventListener("abort", () => { reject(failure()); }, { once: true }); });
    },
    writeAll(_fd, bytes) { calls.written.push(new TextDecoder().decode(bytes)); return Promise.resolve(); },
    close(fd) { calls.closed.push(fd); return Promise.resolve(); },
  } satisfies NativeRunHost["files"];
  const process = {
    spawn(spec) {
      calls.spawned.push(spec);
      return Promise.resolve(script.pipes === "missing" ? { pid, stdin: null, stdout, stderr } : { pid, stdin, stdout, stderr });
    },
    wait() {
      if (script.hang === true) return killed.promise.then((): ProcessExit => ({ kind: "signaled", signal: knownLinuxSignal(9), signalNumber: 9 }));
      return Promise.resolve(script.exit ?? { kind: "exited", code: 0 });
    },
    signal(target, signal) { calls.signals.push([target, signal]); killed.resolve(undefined); return Promise.resolve(); },
  } satisfies NativeRunHost["process"];
  return { host: { files, process } satisfies NativeRunHost, calls };
}

const request = (overrides: Partial<NativeRunRequest> = {}): NativeRunRequest => ({ argv: ["/bin/echo", "hello"], timeoutMs: 1000, ...overrides });

it("runs a child with piped streams and returns its output, status and pid", async () => {
  const { host, calls } = fakeHost({ stdout: ["hel", "lo\n"], stderr: ["warn\n"], exit: { kind: "exited", code: 3 } });
  await expect(runNative(host, request({ input: "payload" }))).resolves.toEqual({ pid: 7, returncode: 3, stdout: "hello\n", stderr: "warn\n" });
  expect(calls.spawned).toEqual([{ command: "/bin/echo", args: ["hello"], cwd: "/workspace", stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } }]);
  expect(calls.written).toEqual(["payload"]);
  expect([...calls.closed].sort()).toEqual([stdin, stdout, stderr]);
  expect(calls.signals).toEqual([]);
});

it("reports a signal death as the negative signal number", async () => {
  const { host } = fakeHost({ exit: { kind: "signaled", signal: knownLinuxSignal(11), signalNumber: 11 } });
  await expect(runNative(host, request())).resolves.toMatchObject({ returncode: -11 });
});

it("rejects invalid arguments, input and deadlines before spawning anything", async () => {
  const { host, calls } = fakeHost();
  const cases: readonly Partial<NativeRunRequest>[] = [
    { argv: [] }, { argv: ["uname"] }, { argv: ["/bin/una\0me"] }, { argv: Array.from({ length: 65 }, () => "/bin/true") },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 180_001 }, { timeoutMs: Number.NaN }, { timeoutMs: 0.5 },
    { input: "x".repeat(5 * 1024 ** 2 + 1) },
  ];
  for (const overrides of cases) await expect(runNative(host, request(overrides)), JSON.stringify(overrides).slice(0, 60)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(calls.spawned).toEqual([]);
  await expect(runNative(host, request({ argv: ["/bin/true"], timeoutMs: 180_000 }))).resolves.toMatchObject({ returncode: 0 });
});

it("kills the child and rejects when the deadline passes", async () => {
  vi.useFakeTimers();
  const { host, calls } = fakeHost({ hang: true });
  const running = runNative(host, request({ timeoutMs: 50 }));
  const outcome = expect(running).rejects.toMatchObject({ code: "ABORTED" });
  await vi.advanceTimersByTimeAsync(50);
  await outcome;
  expect(calls.signals).toEqual([[7, 9]]);
  expect([...calls.closed].sort()).toEqual([stdin, stdout, stderr]);
});

it("kills the child when the caller cancels, and carries the caller's reason", async () => {
  const { host, calls } = fakeHost({ hang: true });
  const cancel = new AbortController();
  const running = runNative(host, request({ signal: cancel.signal }));
  const outcome = expect(running).rejects.toThrow("module stopped");
  await vi.waitFor(() => { expect(calls.spawned).toHaveLength(1); });
  cancel.abort(new Error("module stopped"));
  await outcome;
  expect(calls.signals).toEqual([[7, 9]]);
});

it("spawns nothing when the caller's signal is already aborted", async () => {
  const { host, calls } = fakeHost({ hang: true });
  await expect(runNative(host, request({ signal: AbortSignal.abort(new Error("already stopped")) }))).rejects.toThrow("already stopped");
  expect(calls.spawned).toEqual([]);
});

it("stops a child that floods its output and reports the quota", async () => {
  const { host, calls } = fakeHost({ stdout: ["a".repeat(40), "b".repeat(40)], hang: true });
  await expect(runNative(host, request({ maxOutputBytes: 64 }))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(calls.signals).toEqual([[7, 9]]);
});

it("refuses a child that lacks a requested pipe and still releases the ones it has", async () => {
  const { host, calls } = fakeHost({ pipes: "missing", hang: true });
  await expect(runNative(host, request())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(calls.signals).toEqual([[7, 9]]);
  expect([...calls.closed].sort()).toEqual([stdout, stderr]);
});
