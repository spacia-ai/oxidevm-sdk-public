import {
  deserializeError,
  VMError,
} from "./errors.js";
import {
  decodeSystemExecutionWireEvent,
  PROTOCOL_VERSION,
  type CoreProbeExit,
  type SystemExecutionEvent,
} from "./protocol.js";

export interface SystemExecution {
  readonly events: ReadableStream<SystemExecutionEvent>;
  readonly exit: Promise<CoreProbeExit>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

interface SystemExecutionControls {
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

interface QueuedExecutionEvent {
  readonly event: SystemExecutionEvent;
  readonly consoleSequence?: number;
}

export class SystemExecutionTransport implements SystemExecution {
  readonly events: ReadableStream<SystemExecutionEvent>;
  readonly exit: Promise<CoreProbeExit>;
  readonly #port: MessagePort;
  readonly #sessionId: number;
  readonly #controls: SystemExecutionControls;
  readonly #queued: QueuedExecutionEvent[] = [];
  readonly #resolveExit: (exit: CoreProbeExit) => void;
  readonly #rejectExit: (error: Error) => void;
  #controller: ReadableStreamDefaultController<SystemExecutionEvent> | undefined;
  #expectedSequence = 1;
  #demand = false;
  #terminal = false;
  #closed = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    port: MessagePort,
    sessionId: number,
    controls: SystemExecutionControls,
  ) {
    this.#port = port;
    this.#sessionId = sessionId;
    this.#controls = controls;
    let resolveExit: ((exit: CoreProbeExit) => void) | undefined;
    let rejectExit: ((error: Error) => void) | undefined;
    this.exit = new Promise<CoreProbeExit>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    if (resolveExit === undefined || rejectExit === undefined) {
      throw new VMError("PROTOCOL_ERROR", "failed to create execution result");
    }
    this.#resolveExit = resolveExit;
    this.#rejectExit = rejectExit;
    this.events = new ReadableStream<SystemExecutionEvent>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          this.#demand = true;
          this.#deliver();
        },
        cancel: () => this.stop(),
      },
      { highWaterMark: 0 },
    );
    port.addEventListener("message", this.#onMessage);
    port.addEventListener("messageerror", this.#onMessageError);
    port.start();
  }

  /** True until the execution ends or is asked to stop. */
  get running(): boolean {
    return !this.#closed && !this.#terminal && this.#stopPromise === undefined;
  }

  pause(): Promise<void> {
    return this.running ? this.#controls.pause() : Promise.resolve();
  }

  resume(): Promise<void> {
    return this.running ? this.#controls.resume() : Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.#closed || this.#terminal) return Promise.resolve();
    this.#stopPromise ??= this.#controls.stop().catch((error: unknown) => {
      this.fail(error);
      throw error;
    });
    return this.#stopPromise;
  }

  fail(reason: unknown): void {
    if (this.#closed) return;
    const error =
      reason instanceof Error
        ? reason
        : new VMError("PROTOCOL_ERROR", String(reason));
    this.#closed = true;
    if (!this.#terminal && this.#stopPromise === undefined) {
      this.#stopPromise = this.#controls.stop().catch(() => undefined);
    }
    this.#detach();
    this.#controller?.error(error);
    this.#rejectExit(error);
  }

  readonly #onMessage = (event: MessageEvent<unknown>) => {
    try {
      const message = decodeSystemExecutionWireEvent(event.data);
      if (message.sessionId !== this.#sessionId) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "system execution session does not match",
        );
      }
      if (message.sequence !== this.#expectedSequence) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "system execution event sequence is invalid",
        );
      }
      this.#expectedSequence += 1;
      switch (message.type) {
        case "console":
          this.#queued.push({
            event: { kind: "console", data: message.data },
            consoleSequence: message.sequence,
          });
          this.#deliver();
          return;
        case "telemetry": {
          const telemetry: SystemExecutionEvent = {
            kind: "telemetry",
            runtime: message.runtime,
            workerTimestamp: message.workerTimestamp,
          };
          const queued = { event: telemetry };
          const last = this.#queued.at(-1);
          if (last?.event.kind === "telemetry") {
            this.#queued[this.#queued.length - 1] = queued;
          } else {
            this.#queued.push(queued);
          }
          this.#deliver();
          return;
        }
        case "exit":
          this.#terminal = true;
          this.#detach();
          this.#resolveExit(message.exit);
          this.#deliver();
          return;
        case "error":
          this.#terminal = true;
          this.fail(deserializeError(message.error));
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  };

  readonly #onMessageError = () => {
    this.fail(
      new VMError(
        "PROTOCOL_ERROR",
        "system execution stream could not be decoded",
      ),
    );
  };

  #deliver(): void {
    if (this.#closed || !this.#demand) return;
    const queued = this.#queued.shift();
    if (queued === undefined) {
      if (this.#terminal) this.#close();
      return;
    }
    this.#demand = false;
    this.#controller?.enqueue(queued.event);
    if (queued.consoleSequence !== undefined && !this.#terminal) {
      this.#port.postMessage({
        version: PROTOCOL_VERSION,
        sessionId: this.#sessionId,
        type: "console-ack",
        sequence: queued.consoleSequence,
      });
    }
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#controller?.close();
  }

  #detach(): void {
    this.#port.removeEventListener("message", this.#onMessage);
    this.#port.removeEventListener("messageerror", this.#onMessageError);
    this.#port.close();
  }
}
