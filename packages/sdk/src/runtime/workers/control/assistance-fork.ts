import { serializeUnknownError, VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS, type AssistanceIdentity, type AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceReply } from "../../protocol/assistance-reply.js";
import type { AssistedDependencyIdentity, BrokerEvent, ForkTermination } from "../../protocol/assistance-broker.js";
import type { Task, TaskOutcome } from "./assistance-task.js";

/** What fork supervision needs from the task owner. Every identity, credit
 * and Linux call still flows through SystemAssistance's single owners. */
export interface ForkContext {
  supportsFork(): boolean;
  hasCapacity(): boolean;
  createTask(parent: Task, silent: boolean): Task;
  admit(task: Task): Promise<void>;
  call(task: Task, operation: AssistanceOperation): Promise<AssistanceReply>;
  post(command: object, transfer?: readonly Transferable[]): void;
  reply(reply: AssistanceReply): void;
  retire(task: Task, outcome: TaskOutcome): Promise<void>;
  input(process: number, bytes: Uint8Array<ArrayBuffer> | null): Promise<void>;
  nextCommand(task: Task): AssistanceIdentity;
  reserve(task: Task, bytes: number): number;
  release(task: Task, reservation: number): void;
  running(task: Task): boolean;
  requireStarting(task: Task): void;
}

/** Control-side fork supervision: reserves the child, issues the guest Fork
 * on the parent, answers the parent's mailbox before the child worker spends
 * its budget, then routes the child's output, input, signals and termination
 * to its parent. Control alone allocates identities; workers describe. */
export class ForkSupervision {
  readonly #context: ForkContext;
  constructor(context: ForkContext) { this.#context = context; }

  async fork(parent: Task, event: Extract<BrokerEvent, { kind: "fork" }>): Promise<void> {
    const refuse = (errno: number, code: string) => this.#context.post({ kind: "fork-reply", identity: event.identity, reply: { kind: "error", errno, code } });
    if (!this.#context.supportsFork()) { refuse(38, "ENOSYS"); return; }
    if (!this.#context.hasCapacity()) { refuse(11, "EAGAIN"); return; }
    const child = this.#context.createTask(parent, event.request.silent);
    let replied = false;
    try {
      await this.#context.admit(child);
      const dependencies = child.dependencies === undefined ? null : identityBytes(child.dependencies);
      const forked = await this.#context.call(parent, { kind: "fork", process: child.process, dependencies });
      if (forked.result.kind === "error") {
        throw new VMError("GUEST_CRASH", "Linux refused the fork", { errno: forked.result.errno, guestCode: forked.result.code, syscall: forked.result.syscall });
      }
      if (forked.result.kind !== "spawned") throw new VMError("PROTOCOL_ERROR", "Guest did not fork the assisted child");
      // The helper is the parent service's native child; its single exit event
      // belongs to control (see SystemAssistance), never to the parent's app.
      parent.helpers.add(forked.result.child);
      this.#context.requireStarting(child);
      // Node's fork() returns once the child exists. Answer the parent before
      // the child worker's runtime budget is spent.
      this.#context.post({ kind: "fork-reply", identity: event.identity, reply: { kind: "spawned", process: child.process, pid: forked.result.pid } });
      replied = true;
      const started = await this.#context.call(child, { kind: "start", cwd: event.request.cwd, env: event.request.env });
      if (started.result.kind !== "started") throw new VMError("PROTOCOL_ERROR", "Guest did not initialize the forked task");
      this.#context.requireStarting(child);
      child.brokerStarted = true;
      this.#context.post({ kind: "start", identity: this.#context.nextCommand(child), entry: event.request.entry, cwd: started.result.cwd,
        args: event.request.args, env: started.result.env, ...(child.dependencies === undefined ? {} : { dependencies: child.dependencies }),
        parent: parent.process, silent: event.request.silent, execArgv: event.request.execArgv });
    } catch (error) {
      if (!replied) { const failure = nodeErrno(error); refuse(failure.errno, failure.code); }
      await this.#context.retire(child, { error });
    }
  }

  /** A silent child's output chunk travels to its parent worker and is
   * answered to the child only once the parent acknowledged that chunk. */
  output(child: Task, event: Extract<BrokerEvent, { kind: "output" }>): void {
    const parent = child.parent;
    if (parent === undefined) throw new VMError("PROTOCOL_ERROR", "Silent output without a parent");
    let pending = 0;
    for (const chunk of child.forkOutput.values()) pending += chunk.event.bytes.byteLength;
    if (child.forkOutput.size >= 128 || pending + event.bytes.byteLength > ASSISTANCE_LIMITS.stream) {
      throw new VMError("QUOTA_EXCEEDED", "Fork output capacity exhausted");
    }
    if (!this.#context.running(parent)) return;
    const reservation = this.#context.reserve(child, event.bytes.byteLength * 2 + 128);
    if (child.forkChunk === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Fork output chunk identities exhausted");
    const chunk = ++child.forkChunk;
    child.forkOutput.set(chunk, { event, reservation });
    this.#context.post({ kind: "fork-output", identity: this.#context.nextCommand(parent), child: child.process, stream: event.stream, bytes: event.bytes, chunk }, [event.bytes.buffer]);
  }

  outputAcknowledged(parent: Task, event: Extract<BrokerEvent, { kind: "fork-output-ack" }>): void {
    // A parent may acknowledge a chunk after its child was retired and the
    // chunk's reservation released; that late credit has nowhere to go.
    const child = [...parent.children].find(child => child.process === event.child);
    if (child === undefined) return;
    const pending = child.forkOutput.get(event.chunk);
    if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown fork output acknowledgement");
    child.forkOutput.delete(event.chunk);
    this.#context.release(child, pending.reservation);
    this.#context.reply({ ...pending.event.identity, result: { kind: "unit" } });
  }

  async input(parent: Task, event: Extract<BrokerEvent, { kind: "fork-input" }>): Promise<void> {
    try {
      const child = this.#child(parent, event.child);
      await this.#context.input(child.process, event.bytes);
      this.#context.reply({ ...event.identity, result: { kind: "unit" } });
    } catch {
      this.#context.reply({ ...event.identity, result: { kind: "error", errno: 32, code: "EPIPE", syscall: "write", path: null, destination: null } });
    }
  }

  signal(parent: Task, event: Extract<BrokerEvent, { kind: "fork-signal" }>): void {
    const child = [...parent.children].find(child => child.process === event.child);
    if (child === undefined || !this.#context.running(child)) {
      this.#context.reply({ ...event.identity, result: { kind: "error", errno: 3, code: "ESRCH", syscall: "kill", path: null, destination: null } });
      return;
    }
    // KILL is never delivered to JavaScript: control retires the child.
    if (event.signal === "KILL") void this.#context.retire(child, { signal: 9 }).catch(() => undefined);
    else this.#context.post({ kind: "signal", identity: this.#context.nextCommand(child), signal: event.signal });
    this.#context.reply({ ...event.identity, result: { kind: "unit" } });
  }

  /** The child is gone: its parent learns exactly one termination, if it is
   * still running to hear it. */
  terminated(child: Task, outcome: TaskOutcome): void {
    const parent = child.parent;
    if (parent === undefined) return;
    parent.children.delete(child);
    if (!this.#context.running(parent)) return;
    this.#context.post({ kind: "fork-exit", identity: this.#context.nextCommand(parent), child: child.process, termination: termination(outcome) });
  }

  #child(parent: Task, process: number): Task {
    const child = [...parent.children].find(child => child.process === process);
    if (child === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown fork child");
    return child;
  }
}

function termination(outcome: TaskOutcome): ForkTermination {
  if ("code" in outcome) return { kind: "exit", code: outcome.code };
  if ("signal" in outcome) {
    const signal = outcome.signal;
    if (signal === 1 || signal === 2 || signal === 9 || signal === 15) return { kind: "signal", signal };
    return { kind: "error", error: serializeUnknownError(new VMError("GUEST_CRASH", "Fork child ended by an unsupported signal", { signal })) };
  }
  return { kind: "error", error: serializeUnknownError(outcome.error) };
}

/** Generation then inputs: the identity a fork child must inherit exactly. */
export function identityBytes(dependencies: AssistedDependencyIdentity): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(64);
  const hex = dependencies.generation + dependencies.inputsSha256;
  for (let index = 0; index < 64; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function nodeErrno(error: unknown): { readonly errno: number; readonly code: string } {
  if (error instanceof VMError) {
    const errno = error.detail?.["errno"]; const code = error.detail?.["guestCode"];
    if (typeof errno === "number" && Number.isInteger(errno) && errno >= 1 && errno <= 4095 && typeof code === "string" && /^E[A-Z0-9]{1,15}$/u.test(code)) return { errno, code };
    const mapped = NODE_ERRNO_BY_CODE[error.code];
    if (mapped !== undefined) return mapped;
  }
  return { errno: 5, code: "EIO" };
}

/** SDK failure families with a Node errno of their own; everything else is EIO. */
const NODE_ERRNO_BY_CODE: Partial<Record<VMError["code"], { readonly errno: number; readonly code: string }>> = {
  QUOTA_EXCEEDED: { errno: 11, code: "EAGAIN" },
  FEATURE_NOT_AVAILABLE: { errno: 38, code: "ENOSYS" },
  ABORTED: { errno: 125, code: "ECANCELED" },
};
