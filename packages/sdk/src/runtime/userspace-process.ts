import { VMError } from "./errors.js";
import { rejectingTimeout } from "./disposal.js";
import { GuestProcessTransport } from "./guest-process.js";
import {
  type UserspaceOperations,
  type UserspaceExecutionProfile,
  type UserspaceTerminalSize,
  decodeAccelerationNoticeMessage,
  userspaceResponseDecoders,
} from "./userspace-protocol.js";
import type { AccelerationNotice } from "./js-process/late-failure.js";
import type { UserspaceSyscallTraceSnapshot } from "./userspace-abi.js";
import type { ListeningPortsRead } from "./listening-ports.js";
import type { FileMount } from "./protocol/userspace-files.js";
import type { ProcessHandle } from "./vm-types.js";
import type { PreparedUserspaceRootfs } from "./protocol/storage.js";
import { controlResponseDecoders, PROTOCOL_VERSION, type ControlOperations } from "./protocol.js";
import type {NativeSpawnResult} from "./userspace-protocol.js";
import { WorkerClient, workerClientForPort } from "./worker-client.js";

export class UserspaceProcessBackend {
  readonly #client: WorkerClient<UserspaceOperations>;
  readonly #control: WorkerClient<ControlOperations>;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(client: WorkerClient<UserspaceOperations>, control: WorkerClient<ControlOperations>) {
    this.#client = client;
    this.#control = control;
  }

  static async create(
    options: UserspaceOperations["initialize"]["request"],
    snapshotPort?: MessagePort,
  ): Promise<UserspaceProcessBackend> {
    const { storagePort, networkPort, nativeExecutionPort } = options;
    const control = new WorkerClient<ControlOperations>(
      new Worker(new URL("./workers/control.worker.js", import.meta.url), {
        name: "oxidevm-control",
        type: "module",
      }),
      controlResponseDecoders,
    );
    const channel = new MessageChannel();
    const client = workerClientForPort(channel.port1, userspaceResponseDecoders);
    try {
      await control.request("attach-userspace", { port: channel.port2, ...(snapshotPort === undefined ? {} : { snapshotPort }) },
        { transfer: [channel.port2, ...(snapshotPort === undefined ? [] : [snapshotPort])] });
      await client.request(
        "initialize",
        options,
        storagePort === undefined && networkPort === undefined && nativeExecutionPort === undefined
          ? {}
          : { transfer: [storagePort, networkPort, nativeExecutionPort].filter((port): port is MessagePort => port !== undefined) },
      );
      return new UserspaceProcessBackend(client, control);
    } catch (error) {
      client.terminate();
      control.terminate();
      throw error;
    }
  }

  get control(): WorkerClient<ControlOperations> { return this.#control; }

  attachProcess(attachmentKey: number, terminal: boolean, tail: Uint8Array, signal?: AbortSignal): Promise<ProcessHandle & { readonly pid: number }> {
    return this.#spawn(signal, port => this.#client.request("attach-process", { attachmentKey, port }, { transfer: [port] }), terminal, tail);
  }

  async spawn(
    elf: Uint8Array,
    arguments_: readonly string[],
    rootfs: Uint8Array,
    signal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
    cwd = "/",
    terminal?: UserspaceTerminalSize,
  ): Promise<ProcessHandle & { readonly pid: number }> {
    const elfCopy = elf.slice();
    const rootfsCopy = rootfs.slice();
    return this.#spawn(signal, (port) => this.#client.request(
        "spawn",
        {
          elf: elfCopy,
          arguments: arguments_,
          environment: encodeEnvironment(environment),
          cwd,
          rootfs: rootfsCopy,
          port,
          ...(terminal === undefined ? {} : { terminal }),
        },
        { transfer: [elfCopy.buffer, rootfsCopy.buffer, port] },
      ), terminal !== undefined);
  }

  async spawnManaged(
    rootfs: PreparedUserspaceRootfs,
    executable: string,
    arguments_: readonly string[],
    signal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
    cwd = "/",
    terminal?: UserspaceTerminalSize,
  ): Promise<ProcessHandle & { readonly pid: number }> {
    const metadata = rootfs.metadata.slice();
    return this.#spawn(signal, (port) => this.#client.request(
      "spawn-managed",
      {
        rootTreeSha256: rootfs.rootTreeSha256,
        workspaceBaseSha256: rootfs.workspaceBaseSha256 ?? rootfs.rootTreeSha256,
        cpuProfile: rootfs.cpuProfile,
        executable,
        arguments: arguments_,
        environment: encodeEnvironment(environment),
        cwd,
        rootfs: metadata,
        port,
        ...(terminal === undefined ? {} : { terminal }),
      },
      { transfer: [metadata.buffer, port] },
    ), terminal !== undefined);
  }

  spawnJS(rootfs: PreparedUserspaceRootfs, worker: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd: string, terminal?: UserspaceTerminalSize, signal?: AbortSignal): Promise<ProcessHandle & { readonly pid: number }> {
    const metadata = rootfs.metadata.slice();
    return this.#spawn(signal, port => this.#client.request("spawn-js", { rootTreeSha256: rootfs.rootTreeSha256, workspaceBaseSha256: rootfs.workspaceBaseSha256 ?? rootfs.rootTreeSha256, cpuProfile: rootfs.cpuProfile, worker, arguments: args, environment: encodeEnvironment(env), cwd, rootfs: metadata, port, ...(terminal === undefined ? {} : { terminal }) }, { transfer: [metadata.buffer, port] }), terminal !== undefined);
  }

  async #spawn(
    signal: AbortSignal | undefined,
    request: (port: MessagePort) => Promise<NativeSpawnResult>,
    terminal: boolean,
    initialStdout?: Uint8Array,
  ): Promise<ProcessHandle & { readonly pid: number }> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    if (creationCancelled(signal)) throw new VMError("ABORTED", "process creation cancelled");
    const channel = new MessageChannel();
    let spawned: NativeSpawnResult;
    try {
      spawned = await request(channel.port2);
    } catch (error) {
      channel.port1.close();
      throw error;
    }
    const process = new GuestProcessTransport(channel.port1, spawned.pid, spawned.sessionId, {
      snapshotKey:`process:${String(spawned.identityKey)}`,
      ...(initialStdout === undefined ? {} : { initialStdout }),
      lifetime: AbortSignal.any([this.#client.lifetime, this.#control.lifetime]),
      write: (data) => {
        const copy = data.slice();
        return this.#client.request("stdin", { pid: spawned.pid, sessionId: spawned.sessionId, data: copy }, { transfer: [copy.buffer] });
      },
      closeStdin: () => this.#client.request("close-stdin", { pid: spawned.pid, sessionId: spawned.sessionId }),
      resizeTerminal: terminal => this.#client.request("resize-terminal", { pid: spawned.pid, sessionId: spawned.sessionId, terminal }),
      signal: (requested) => this.#client.request("signal", { pid: spawned.pid, sessionId: spawned.sessionId, signal: requested }),
      signalNamed: (requested, scope) => this.#client.request("signal-named", { pid: spawned.pid, sessionId: spawned.sessionId, signal: requested, scope }),
      resize: size => this.#client.request("terminal-resize", { pid: spawned.pid, sessionId: spawned.sessionId, terminal: size }),
      interrupt: () => this.#client.request("terminal-interrupt", { pid: spawned.pid, sessionId: spawned.sessionId }),
    }, terminal);
    // Admission must return its PID before cancellation can retire the process.
    if (creationCancelled(signal)) {
      await Promise.all([process.stdout.cancel(), process.stderr.cancel()]);
      await process.sendSignal("SIGKILL", "process-group");
      await process.exit;
      throw new VMError("ABORTED", "process creation cancelled");
    }
    return process;
  }

  readJSProcessTrace(capacity?: number): Promise<Uint8Array> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("js-trace", capacity === undefined ? {} : { capacity });
  }

  /** ADR 0026: calls `listener` with each late fast-path failure until `signal` aborts or the
   * runtime ends. The request carries no signal, so the runtime always answers and never keeps
   * an orphaned subscription; a malformed notice or a throwing listener ends the watch with
   * that error. */
  async watchAccelerationNotices(listener: (notice: AccelerationNotice) => void, signal: AbortSignal): Promise<void> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    const port = await this.#client.request("acceleration-notices", undefined);
    const ended = AbortSignal.any([signal, this.#client.lifetime]);
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    const finish = (error?: unknown): void => {
      ended.removeEventListener("abort", stop);
      port.onmessage = null;
      port.postMessage({ version: PROTOCOL_VERSION, type: "close" });
      port.close();
      if (error === undefined) resolve(undefined); else reject(error);
    };
    const stop = (): void => { finish(); };
    port.onmessage = event => {
      try { listener(decodeAccelerationNoticeMessage(event.data)); } catch (error) { finish(error); }
    };
    if (ended.aborted) finish(); else ended.addEventListener("abort", stop, { once: true });
    await promise;
  }

  async readSyscallTrace(pid: number): Promise<UserspaceSyscallTraceSnapshot> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("read-syscall-trace", { pid });
  }

  async readExecutionProfile(pid: number): Promise<UserspaceExecutionProfile> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("read-execution-profile", { pid });
  }

  /** The runtime's listeners; `ports` is null while the generation `known` stands. */
  async listeningPorts(known: bigint | null, signal?: AbortSignal): Promise<ListeningPortsRead> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("listening-ports", { known }, signal === undefined ? undefined : { signal });
  }

  /** Private native-file transport; wire records never leave the SDK. */
  async files(request: Uint8Array<ArrayBuffer>, mount?: FileMount, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("files", { request, ...(mount === undefined ? {} : { mount }) }, { signal, transfer: [request.buffer] });
  }

  async fileChanges(cursor: bigint, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "Userspace backend is disposed");
    return this.#client.request("file-changes", { cursor }, { signal });
  }

  async revokeNetwork(): Promise<void> {
    if (!this.#disposed) await this.#client.request("network-revoke", undefined);
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    try { await rejectingTimeout(this.#retire()); }
    finally { this.#client.terminate(); this.#control.terminate(); }
  }

  async #retire(): Promise<void> {
    try {
      await this.#client.request("dispose", undefined);
    } finally {
      this.#client.terminate();
      try {
        await this.#control.request("dispose", undefined);
      } finally {
        this.#control.terminate();
      }
    }
  }
}

function creationCancelled(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function encodeEnvironment(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}
