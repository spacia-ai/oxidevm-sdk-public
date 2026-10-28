import { deserializeError, VMError } from "./errors.js";
import { decodeLinuxSignal, knownLinuxSignal, type LinuxSignal, type SignalScope } from "./process-signals.js";
import type { ProcessTermination } from "./protocol/agent.js";
import {
  decodeGuestProcessWireEvent,
  PROTOCOL_VERSION,
} from "./protocol.js";

export const STREAM_HIGH_WATER_BYTES = 64 * 1024;
export const STDIN_CHUNK_BYTES = 1024 * 1024;

type ProcessExit = { code: number | null; signal?: string };

export interface GuestProcessControl {
  readonly snapshotKey?:string;
  readonly lifetime?: AbortSignal;
  /** Already acknowledged screen bytes precede live output without another guest acknowledgement. */
  readonly initialStdout?: Uint8Array;
  write(data: Uint8Array): Promise<number>;
  closeStdin(): Promise<void>;
  signal(signal: "TERM" | "KILL" | "INT" | "HUP"): Promise<void>;
  signalNamed?(signal: LinuxSignal, scope: SignalScope): Promise<void>;
  resize?(size: { readonly columns: number; readonly rows: number }): Promise<void>;
  interrupt?(): Promise<void>;
  resizeTerminal?(size: { readonly columns: number; readonly rows: number }): Promise<void>;
}

export class GuestProcessTransport {
  readonly snapshotKey?:string;
  readonly terminal: boolean;
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  readonly termination: Promise<ProcessTermination>;

  readonly #port: MessagePort;
  readonly #sessionId: number;
  readonly #control: GuestProcessControl;
  readonly #resolveExit: (value: ProcessExit) => void;
  readonly #rejectExit: (reason: unknown) => void;
  readonly #resolveTermination: (value: ProcessTermination) => void;
  readonly #rejectTermination: (reason: unknown) => void;
  #stdinController: WritableStreamDefaultController | undefined;
  #stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #stdoutCanceled = false;
  #stderrCanceled = false;
  #pendingAck:
    | {
        readonly sequence: number;
        readonly type: "stdout" | "stderr";
      }
    | undefined;
  #lastSequence = 0;
  #settled = false;
  #exitReceived = false;

  constructor(
    port: MessagePort,
    pid: number,
    sessionId: number,
    control: GuestProcessControl,
    terminal = false,
  ) {
    this.#port = port;
    this.pid = pid;
    this.#sessionId = sessionId;
    this.#control = control;
    if(control.snapshotKey!==undefined)this.snapshotKey=control.snapshotKey;
    this.terminal = terminal;
    let resolveExit: ((value: ProcessExit) => void) | undefined;
    let rejectExit: ((reason: unknown) => void) | undefined;
    this.exit = new Promise((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    if (resolveExit === undefined || rejectExit === undefined) {
      throw new VMError("PROTOCOL_ERROR", "failed to create process exit");
    }
    this.#resolveExit = resolveExit;
    this.#rejectExit = rejectExit;
    let resolveTermination: ((value: ProcessTermination) => void) | undefined;
    let rejectTermination: ((reason: unknown) => void) | undefined;
    this.termination = new Promise((resolve, reject) => { resolveTermination = resolve; rejectTermination = reject; });
    if (resolveTermination === undefined || rejectTermination === undefined) throw new VMError("PROTOCOL_ERROR", "failed to create process termination");
    this.#resolveTermination = resolveTermination;
    this.#rejectTermination = rejectTermination;
    void this.termination.catch(() => {});

    this.stdout = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#stdoutController = controller;
          if (control.initialStdout !== undefined && control.initialStdout.length !== 0) controller.enqueue(control.initialStdout.slice());
        },
        pull: () => {
          this.#ackOutput("stdout");
        },
        cancel: () => {
          this.#stdoutCanceled = true;
          this.#ackOutput("stdout", true);
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: STREAM_HIGH_WATER_BYTES,
      }),
    );
    this.stderr = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#stderrController = controller;
        },
        pull: () => {
          this.#ackOutput("stderr");
        },
        cancel: () => {
          this.#stderrCanceled = true;
          this.#ackOutput("stderr", true);
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: STREAM_HIGH_WATER_BYTES,
      }),
    );
    this.stdin = new WritableStream<Uint8Array>({
      start: controller => { this.#stdinController = controller; },
      write: async (chunk) => {
        for (let offset = 0; offset < chunk.byteLength; ) {
          const end = Math.min(offset + STDIN_CHUNK_BYTES, chunk.byteLength);
          const bytes = chunk.slice(offset, end);
          const accepted = await this.#control.write(bytes);
          if (accepted < 1 || accepted > bytes.byteLength) {
            throw new VMError(
              "GUEST_CRASH",
              "guest process made no stdin progress",
            );
          }
          offset += accepted;
        }
      },
      close: () => this.#control.closeStdin(),
      abort: () => this.#control.signal("KILL"),
    });

    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#receive(event.data);
    });
    port.addEventListener("messageerror", () => {
      this.#fail(
        new VMError("PROTOCOL_ERROR", "guest process event is malformed"),
      );
    });
    port.start();
    control.lifetime?.addEventListener("abort", this.#ownerLost, { once: true });
    if (control.lifetime?.aborted === true) this.#ownerLost();
  }

  kill(signal = "TERM"): Promise<void> {
    if (this.#settled) return Promise.reject(new VMError("PROTOCOL_ERROR", "guest process has exited"));
    if (
      signal !== "TERM" &&
      signal !== "KILL" &&
      signal !== "INT" &&
      signal !== "HUP"
    ) {
      return Promise.reject(
        new VMError("INVALID_ARGUMENT", "unsupported guest signal"),
      );
    }
    return this.#control.signal(signal);
  }

  async sendSignal(signal: LinuxSignal, scope: SignalScope): Promise<void> {
    const name = decodeLinuxSignal(signal);
    const requestedScope: unknown = scope;
    if (requestedScope !== "process" && requestedScope !== "process-group") throw new VMError("INVALID_ARGUMENT", "invalid signal scope");
    if (this.#exitReceived) return;
    if (this.#settled) throw new VMError("PROTOCOL_ERROR", "guest process owner is unavailable");
    if (this.#control.signalNamed !== undefined) return this.#control.signalNamed(name, scope);
    if (scope === "process") {
      if (name === "SIGTERM") return this.kill("TERM");
      if (name === "SIGKILL") return this.kill("KILL");
      if (name === "SIGINT") return this.kill("INT");
      if (name === "SIGHUP") return this.kill("HUP");
    }
    throw new VMError("FEATURE_NOT_AVAILABLE", "the guest process owner does not support this signal operation", { reason: "image-unsupported" });
  }

  async resize(size: { readonly columns: number; readonly rows: number }): Promise<void> {
    if (this.#settled) throw new VMError("PROTOCOL_ERROR", "guest process has exited");
    if (!this.terminal || this.#control.resize === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "terminal resize is unavailable", { reason: "image-unsupported" });
    if (!Number.isInteger(size.columns) || !Number.isInteger(size.rows) || size.columns < 1 || size.columns > 1000 || size.rows < 1 || size.rows > 1000) throw new VMError("INVALID_ARGUMENT", "terminal size must contain integers from 1 to 1000");
    return this.#control.resize(size);
  }

  async interrupt(): Promise<void> {
    if (this.#settled) throw new VMError("PROTOCOL_ERROR", "guest process has exited");
    if (!this.terminal || this.#control.interrupt === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "foreground terminal interrupt is unavailable", { reason: "image-unsupported" });
    return this.#control.interrupt();
  }

  resizeTerminal(size: { readonly columns: number; readonly rows: number }): Promise<void> {
    if (![size.columns, size.rows].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) {
      return Promise.reject(new VMError("INVALID_ARGUMENT", "Invalid process terminal size"));
    }
    if (this.#control.resizeTerminal === undefined) {
      return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "Process terminal resize is unavailable"));
    }
    return this.#control.resizeTerminal(size);
  }

  readonly #ownerLost = () => {
    if (this.#control.lifetime?.aborted === true) this.#fail(this.#control.lifetime.reason);
  };

  #receive(value: unknown): void {
    if (this.#settled) return;
    try {
      const event = decodeGuestProcessWireEvent(value);
      if (
        event.sessionId !== this.#sessionId ||
        event.sequence !== this.#lastSequence + 1
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest process event sequence is invalid",
        );
      }
      this.#lastSequence = event.sequence;
      switch (event.type) {
        case "stdout":
        case "stderr":
          this.#receiveOutput(event.type, event.sequence, event.data);
          break;
        case "exit":
          this.#exitReceived = true;
          this.#settled = true;
          this.#control.lifetime?.removeEventListener("abort", this.#ownerLost);
          if (!this.#stdoutCanceled) this.#stdoutController?.close();
          if (!this.#stderrCanceled) this.#stderrController?.close();
          this.#resolveExit(
            event.termination.kind === "exit"
              ? { code: event.termination.code }
              : { code: null, signal: linuxSignalName(event.termination.signal) },
          );
          this.#resolveTermination(event.termination);
          this.#port.close();
          break;
        case "error":
          this.#fail(deserializeError(event.error));
          break;
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #receiveOutput(
    type: "stdout" | "stderr",
    sequence: number,
    data: Uint8Array,
  ): void {
    if (this.#pendingAck !== undefined) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "guest process sent output before acknowledgement",
      );
    }
    this.#pendingAck = { sequence, type };
    const canceled =
      type === "stdout" ? this.#stdoutCanceled : this.#stderrCanceled;
    const controller =
      type === "stdout" ? this.#stdoutController : this.#stderrController;
    if (!canceled) controller?.enqueue(data);
    this.#ackOutput(type, canceled);
  }

  #ackOutput(type: "stdout" | "stderr", force = false): void {
    const pending = this.#pendingAck;
    if (pending === undefined || pending.type !== type) return;
    const controller =
      type === "stdout" ? this.#stdoutController : this.#stderrController;
    if (!force && (controller?.desiredSize ?? 0) <= 0) return;
    this.#pendingAck = undefined;
    this.#port.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      type: "output-ack",
      sequence: pending.sequence,
    });
  }

  #fail(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#control.lifetime?.removeEventListener("abort", this.#ownerLost);
    this.#stdinController?.error(reason);
    if (!this.#stdoutCanceled) this.#stdoutController?.error(reason);
    if (!this.#stderrCanceled) this.#stderrController?.error(reason);
    this.#rejectExit(reason);
    this.#rejectTermination(reason);
    this.#port.close();
  }
}

export function linuxSignalName(signal: number): string {
  return knownLinuxSignal(signal) ?? `SIG${signal}`;
}
