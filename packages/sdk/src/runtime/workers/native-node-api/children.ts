import { NATIVE_TASK_CONTROL_VERSION } from "./thread-metadata.js";
import type { FileDescriptor, NativeChildSpec } from "../../../js-process-types.js";
import { LinuxError, noValue, operation, protocol, Reader, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { decodeSpawn, process as linuxProcess, spawnPayload } from "../../js-process/process.js";
import type { LinuxClient } from "../../js-process/transport.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { decodeForkRequest, type ForkReply, type ForkRequest } from "../../protocol/assistance-fork.js";
import type { ForkExit, ForkEvents, ProcessChildEvent, ProcessRuntimeIO } from "../assistance/process-io.js";
import { nodeError } from "./files.js";
import { captureNativeChild } from "./sync-child.js";
export { NativeChildLaunchFailure } from "./sync-child.js";

interface Child {
  readonly pid: number;
  stdin: FileDescriptor | null;
  readonly credits: Map<number, { readonly bytes: number; readonly stream: "stdout" | "stderr"; readonly resolve: () => void }>;
  exited: boolean;
  streams: number;
  readonly fork: boolean;
  termination?: ForkExit;
}

/** Pipe pumping adapts Rust-owned children. It allocates no process identities. */
export class NativeChildrenIO {
  readonly #children = new Map<number, Child>();
  #sequence = 0;
  #events: ((event: ProcessChildEvent) => void) | undefined;
  #forkEvents: ForkEvents | undefined;
  constructor(readonly client: LinuxClient, readonly failed: (error: unknown) => void, readonly schedule: (callback: () => void) => void, readonly fork?: { readonly control: MessagePort; readonly executable: string }) {}
  setEvents(events: (event: ProcessChildEvent) => void): void {
    if (this.#events !== undefined) protocol("Native child event owner is already set"); this.#events = events;
  }
  setForkEvents(events: ForkEvents): void { if (this.#forkEvents !== undefined) protocol("Native fork events are already connected"); this.#forkEvents = events; }
  spawn(input: Extract<AssistanceOperation, { kind: "spawn" }>, stdio?: NativeChildSpec["stdio"]): AssistanceResult {
    const child = this.#launch(input, undefined, stdio); return { kind: "spawned", child: child.pid, pid: child.pid };
  }
  captureSync(...args: Parameters<NonNullable<ProcessRuntimeIO["captureSync"]>>) {
    if (this.#children.size >= 128) protocol("Native child transport capacity exhausted");
    return captureNativeChild(this.client, ...args);
  }
  forkSync(input: ForkRequest): ForkReply {
    if (this.fork === undefined) protocol("Native fork services are absent");
    const request = decodeForkRequest(input), operation = { kind: "spawn", command: this.fork.executable, args: [...request.execArgv, request.entry, ...request.args], cwd: request.cwd, env: request.env } as const;
    try {
      const child = this.#launch(operation, request), channel = new MessageChannel();
      this.schedule(() => { if (this.#forkEvents === undefined) protocol("Native fork events are absent"); this.#forkEvents.channel(child.pid, channel.port1); });
      this.fork.control.postMessage({ version: NATIVE_TASK_CONTROL_VERSION, type: "prepare", child: child.incarnation, metadata: { port: channel.port2, data: null, execArgv: request.execArgv, transfers: [], autoSelectFamily: null } }, [channel.port2]);
      return { kind: "spawned", process: child.pid, pid: child.pid };
    } catch (error) { const result = nodeError(error, operation); return { kind: "error", errno: result.errno, code: result.code }; }
  }
  #launch(input: Extract<AssistanceOperation, { kind: "spawn" }>, fork?: ForkRequest, stdio?: NativeChildSpec["stdio"]) {
    if (this.#children.size >= 128) protocol("Native child transport capacity exhausted");
    const pipe = fork === undefined || fork.silent ? "pipe" : "inherit";
    const child = this.client.sync(operation(65538, spawnPayload({ command: input.command, args: input.args, cwd: input.cwd, env: input.env, stdio: stdio ?? { stdin: pipe, stdout: pipe, stderr: pipe } }, fork !== undefined), result => {
      if (fork === undefined) return { ...decodeSpawn(result), incarnation: null };
      if (result.bytes.length !== 20) protocol("Invalid native fork result");
      const reader = new Reader(result.bytes.subarray(12)), incarnation = reader.u64(); reader.end(); if (incarnation === 0n) protocol("Missing native fork incarnation");
      return { ...decodeSpawn({ ...result, bytes: result.bytes.subarray(0, 12) }), incarnation };
    }));
    const state: Child = { pid: child.pid, stdin: child.stdin, credits: new Map(), exited: false, streams: Number(child.stdout !== null) + Number(child.stderr !== null), fork: fork !== undefined };
    this.#children.set(child.pid, state);
    const pump = async (stream: "stdout" | "stderr", fd: FileDescriptor | null) => {
      if (fd === null) {
        if (!state.fork) this.#emit({ sequence: this.#next(), event: { kind: "eof", child: child.pid, stream } });
        return;
      }
      try {
        for (;;) {
          const bytes = await this.client.call(files.read(fd, ASSISTANCE_LIMITS.chunk));
          if (bytes.byteLength === 0) break;
          const completion = Promise.withResolvers<undefined>(), sequence = this.#next();
          state.credits.set(sequence, { bytes: bytes.byteLength, stream, resolve: () => completion.resolve(undefined) });
          if (state.fork) this.schedule(() => { this.#forkEvents?.output(child.pid, stream, new Uint8Array(bytes), sequence); });
          else this.#emit({ sequence, event: { kind: "output", child: child.pid, stream, bytes: new Uint8Array(bytes) } });
          await completion.promise;
        }
        if (!state.fork) this.#emit({ sequence: this.#next(), event: { kind: "eof", child: child.pid, stream } });
      } finally { await this.client.call(files.close(fd)); state.streams--; this.#reclaim(state); }
    };
    queueMicrotask(() => {
      void pump("stdout", child.stdout).catch(this.failed);
      void pump("stderr", child.stderr).catch(this.failed);
      void linuxProcess(this.client).wait(child.pid).then(exit => {
        state.exited = true;
        if (state.fork) {
          if (exit.kind === "exited") state.termination = { kind: "exit", code: exit.code };
          else { const signal = exit.signal; if (signal === null) protocol("Unsupported native fork exit signal"); state.termination = { kind: "native-signal", signal }; }
        }
        else this.#emit({ sequence: this.#next(), event: exit.kind === "exited" ? { kind: "exit", child: child.pid, code: exit.code, signal: null } : { kind: "exit", child: child.pid, code: null, signal: exit.signalNumber } });
        this.#reclaim(state);
      }).catch(this.failed);
    });
    return child;
  }
  ackFork(pid: number, sequence: number): void { const child = this.#children.get(pid), credit = child?.credits.get(sequence); if (child === undefined || !child.fork || credit === undefined) protocol("Invalid native fork output credit"); child.credits.delete(sequence); credit.resolve(); }
  signalSync(input: Extract<AssistanceOperation, { kind: "signal" }>): AssistanceResult {
    if (!this.#children.has(input.child)) throw new LinuxError(3);
    const signal = { TERM: 15, KILL: 9, INT: 2, HUP: 1 }[input.signal];
    this.client.sync(operation(62, new Writer().u32(input.child).u8(signal), noValue));
    return { kind: "unit" };
  }
  async call(input: AssistanceOperation): Promise<AssistanceResult> {
    if (!("child" in input)) protocol("Native child operation has no child identity");
    const child = this.#children.get(input.child);
    if (child === undefined) throw new LinuxError(3);
    if (input.kind === "stdin") {
      if (child.stdin === null) throw new LinuxError(9);
      return { kind: "written", count: await this.client.call(files.write(child.stdin, input.bytes)) };
    }
    if (input.kind === "close-stdin") {
      if (child.stdin !== null) { const fd = child.stdin; child.stdin = null; await this.client.call(files.close(fd)); }
    } else if (input.kind === "signal") {
      return this.signalSync(input);
    } else {
      const credit = child.credits.get(input.sequence);
      if (credit === undefined || credit.bytes !== input.bytes || credit.stream !== input.stream) protocol("Invalid native pipe credit");
      child.credits.delete(input.sequence); credit.resolve();
    }
    return { kind: "unit" };
  }
  #next(): number { if (this.#sequence === 0xffff_ffff) protocol("Native child event sequence exhausted"); return ++this.#sequence; }
  #emit(event: ProcessChildEvent): void {
    this.schedule(() => { if (this.#events === undefined) protocol("Native child events are not connected"); this.#events(event); });
  }
  #reclaim(child: Child): void {
    if (!child.exited || child.streams !== 0 || child.credits.size !== 0) return;
    if (child.termination !== undefined) { const termination = child.termination; this.schedule(() => { this.#forkEvents?.exit(child.pid, termination); }); }
    this.#children.delete(child.pid);
    if (child.stdin !== null) { const fd = child.stdin; child.stdin = null; void this.client.call(files.close(fd)).catch(this.failed); }
  }
}
