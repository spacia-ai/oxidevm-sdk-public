import { VMError, serializeUnknownError } from "../../errors.js";
import { decodeSystemExecutionPortAck, PROTOCOL_VERSION, type CoreProbeExit, type SystemSliceResult } from "../../protocol.js";
import { withCoreSteps } from "./core.js";

/** Core execution remains in its existing driver; this owner schedules one session. */
export interface SystemSessionDriver {
  run(deadline: number): Promise<CoreProbeExit>;
  readConsole(): Uint8Array<ArrayBuffer>;
  telemetry(): SystemSliceResult["runtime"];
  pause(paused: boolean): Promise<void>;
  invalidate(): void;
  stopped(error?: unknown): void;
  yield(idle: boolean): Promise<void>;
  recordYield(milliseconds: number): void;
}

/** Where a session's pump is waiting. `run` is a slice in progress; the yields
 * hand the worker back between slices; `console-ack` drains retained console
 * output before a natural exit. A live session that reports no slice progress
 * while `waiting` stays on one value names a stalled scheduler, not a guest. */
export type SessionWaiting = "none" | "run" | "yield-idle" | "yield-task" | "paused" | "console-ack";

export interface SessionDiagnostics {
  readonly active: boolean;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly awaitingConsoleAck: boolean;
  readonly waiting: SessionWaiting;
}

interface Session {
  readonly id: number;
  readonly port: MessagePort;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly receiveAck: (event: MessageEvent<unknown>) => void;
  readonly receiveError: () => void;
  sequence: number;
  steps: bigint;
  paused: boolean;
  stopping: boolean;
  awaitingConsoleAck: number | undefined;
  wake: (() => void) | undefined;
  waiting: SessionWaiting;
}

type SessionEvent =
  | { readonly type: "console"; readonly data: Uint8Array }
  | { readonly type: "telemetry"; readonly runtime: SystemSliceResult["runtime"]; readonly workerTimestamp: number }
  | { readonly type: "exit"; readonly exit: CoreProbeExit }
  | { readonly type: "error"; readonly error: ReturnType<typeof serializeUnknownError> };

export class SystemSessions {
  #session: Session | undefined;

  constructor(private readonly driver: SystemSessionDriver) {}

  get active(): { readonly id: number; readonly paused: boolean } | undefined {
    const session = this.#session;
    return session === undefined ? undefined : { id: session.id, paused: session.paused };
  }

  diagnostics(): SessionDiagnostics {
    const session = this.#session;
    if (session === undefined) return { active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" };
    return { active: true, paused: session.paused, stopping: session.stopping,
      awaitingConsoleAck: session.awaitingConsoleAck !== undefined, waiting: session.waiting };
  }

  start(id: number, port: MessagePort, bootConsole: Uint8Array<ArrayBuffer>): void {
    if (this.#session !== undefined) {
      port.close();
      throw new VMError("INVALID_ARGUMENT", "a system execution session is already active");
    }
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    if (resolveDone === undefined) {
      port.close();
      throw new VMError("PROTOCOL_ERROR", "failed to create system session");
    }
    const session: Session = {
      id, port, done, resolveDone,
      receiveAck: event => this.#ack(session, event.data),
      receiveError: () => this.#fail(session, new VMError("PROTOCOL_ERROR", "system execution acknowledgement could not be decoded")),
      sequence: 0, steps: 0n, paused: false, stopping: false,
      awaitingConsoleAck: undefined, wake: undefined, waiting: "yield-task",
    };
    port.addEventListener("message", session.receiveAck);
    port.addEventListener("messageerror", session.receiveError);
    port.start();
    this.#session = session;
    try {
      if (bootConsole.byteLength !== 0) this.#console(session, bootConsole);
      void this.driver.yield(false).then(() => this.#pump(session)).catch((error: unknown) => this.#fail(session, error));
    } catch (error) {
      this.#fail(session, error);
      throw error;
    }
  }

  async control(id: number, action: "pause" | "resume"): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.id !== id) {
      throw new VMError("INVALID_ARGUMENT", "system session is not active");
    }
    const paused = action === "pause";
    if (session.paused === paused) return;
    await this.driver.pause(paused);
    if (this.#session !== session) throw new VMError("ABORTED", "system session ended while changing pause state");
    session.paused = paused;
    if (!paused) this.#wake(session);
  }

  async stop(id?: number): Promise<void> {
    const session = this.#session;
    if (session === undefined) return;
    if (id !== undefined && session.id !== id) {
      throw new VMError("INVALID_ARGUMENT", "system session is not active");
    }
    if (!session.stopping) {
      session.stopping = true;
      this.driver.invalidate();
      this.#wake(session);
    }
    await session.done;
  }

  fail(error: unknown): void {
    const session = this.#session;
    if (session !== undefined) this.#fail(session, error);
  }

  async #pump(session: Session): Promise<void> {
    let lastTelemetry = performance.now();
    try {
      while (this.#session === session && !session.stopping) {
        if (session.paused) {
          session.waiting = "paused";
          await new Promise<void>(resolve => { session.wake = resolve; });
          continue;
        }
        session.waiting = "run";
        const exit = await this.driver.run(performance.now() + 20);
        if (this.#session !== session) return;
        session.steps += exit.steps;
        // Leave bytes in the bounded virtio console queue until acknowledged.
        // Only its producer backpressures; the CPU and private hvc1 keep running.
        if (session.awaitingConsoleAck === undefined) {
          const console = this.driver.readConsole();
          if (console.byteLength !== 0) this.#console(session, console);
        }
        const now = performance.now();
        if (now - lastTelemetry >= 250 || exit.kind !== "step-limit") {
          this.#post(session, { type: "telemetry", runtime: this.driver.telemetry(), workerTimestamp: now });
          lastTelemetry = now;
        }
        if (exit.kind !== "step-limit") {
          await this.#drainConsole(session);
          if (this.#session !== session) return;
          this.#post(session, { type: "exit", exit: withCoreSteps(exit, session.steps) });
          this.#finish(session);
          return;
        }
        const started = performance.now();
        session.waiting = exit.steps === 0n ? "yield-idle" : "yield-task";
        await this.driver.yield(exit.steps === 0n);
        if (this.#session !== session) return;
        this.driver.recordYield(performance.now() - started);
      }
      if (this.#session === session) {
        this.#post(session, { type: "exit", exit: { kind: "reset", steps: session.steps, reason: "external-reset" } });
        this.#finish(session);
      }
    } catch (error) { this.#fail(session, error); }
  }

  async #drainConsole(session: Session): Promise<void> {
    while (this.#session === session && !session.stopping) {
      if (session.awaitingConsoleAck !== undefined) {
        session.waiting = "console-ack";
        await new Promise<void>(resolve => { session.wake = resolve; });
      } else {
        const bytes = this.driver.readConsole();
        if (bytes.byteLength === 0) return;
        this.#console(session, bytes);
      }
    }
  }

  #ack(session: Session, value: unknown): void {
    try {
      const ack = decodeSystemExecutionPortAck(value);
      if (this.#session !== session || ack.sessionId !== session.id || ack.sequence !== session.awaitingConsoleAck) {
        throw new VMError("PROTOCOL_ERROR", "system console acknowledgement is invalid");
      }
      session.awaitingConsoleAck = undefined;
      this.#wake(session);
    } catch (error) { this.#fail(session, error); }
  }

  #console(session: Session, data: Uint8Array<ArrayBuffer>): void {
    if (session.awaitingConsoleAck !== undefined) {
      throw new VMError("PROTOCOL_ERROR", "system console already awaits acknowledgement");
    }
    session.awaitingConsoleAck = this.#post(session, { type: "console", data }, [data.buffer]);
  }

  #post(session: Session, event: SessionEvent, transfer: Transferable[] = []): number {
    const sequence = ++session.sequence;
    session.port.postMessage({ version: PROTOCOL_VERSION, sessionId: session.id, sequence, ...event }, transfer);
    return sequence;
  }

  #wake(session: Session): void {
    const wake = session.wake;
    session.wake = undefined;
    wake?.();
  }

  #fail(session: Session, error: unknown): void {
    if (this.#session !== session) return;
    try { this.#post(session, { type: "error", error: serializeUnknownError(error) }); }
    catch { session.port.close(); }
    finally { this.#finish(session, error); }
  }

  #finish(session: Session, error?: unknown): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    session.port.removeEventListener("message", session.receiveAck);
    session.port.removeEventListener("messageerror", session.receiveError);
    this.#wake(session);
    session.resolveDone();
    this.driver.stopped(error);
  }
}
