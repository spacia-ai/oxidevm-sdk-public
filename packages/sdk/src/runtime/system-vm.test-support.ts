import { integer, record, string } from "./decode.js";
import { serializeUnknownError, VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import type { RuntimeVM } from "./vm-types.js";

export type RestoreOutcome = "restored" | "refused" | "lost";

/**
 * A control or storage worker that answers the operations a managed boot, restore, spawn and
 * disposal send, as the real workers would.
 */
export class ScriptedWorker extends EventTarget {
  static readonly instances: ScriptedWorker[] = [];
  static restore: RestoreOutcome = "restored";
  static refresh: "stepped" | "fails" = "stepped";
  /** Answers that replace the scripted one, by operation type; a thrown error fails the request. */
  static readonly answers = new Map<string, (input: Record<string, unknown>) => unknown>();
  readonly operations: string[] = [];
  /** Each request's fields, in order. */
  readonly inputs: Record<string, unknown>[] = [];
  /** Each message without a reply, such as the network worker's connections, in order. */
  readonly messages: Record<string, unknown>[] = [];
  readonly #ports: MessagePort[] = [];
  #booted = false;
  #session: { readonly id: number; readonly port: MessagePort } | undefined;

  constructor(_url: URL, readonly options: WorkerOptions) {
    super();
    ScriptedWorker.instances.push(this);
  }

  static named(name: string): ScriptedWorker {
    const worker = ScriptedWorker.instances.find((candidate) => candidate.options.name === name);
    if (worker === undefined) throw new Error(`${name} was not created`);
    return worker;
  }

  postMessage(value: unknown): void {
    const input = record(value, "test worker request");
    const type = string(input["type"], "request type");
    if (input["id"] === undefined) {
      // A message without a reply, such as the network worker's port connections.
      this.operations.push(type);
      this.messages.push(input);
      return;
    }
    const id = integer(input["id"], "request id", 1, 0xffff_ffff);
    this.operations.push(type);
    this.inputs.push(input);
    let answer: unknown;
    try {
      const override = ScriptedWorker.answers.get(type);
      answer = override === undefined ? this.#answer(type, input) : override(input);
      if (type === "restore" && ScriptedWorker.restore === "restored") this.#booted = true;
    } catch (error) {
      this.#reply({ id, version: PROTOCOL_VERSION, ok: false, error: serializeUnknownError(error) });
      return;
    }
    if (answer instanceof Promise) {
      // An answer that waits, such as one that first sends events through a port.
      void answer.then(
        (settled: unknown) => { this.#reply({ id, version: PROTOCOL_VERSION, ok: true, value: settled }); },
        (error: unknown) => { this.#reply({ id, version: PROTOCOL_VERSION, ok: false, error: serializeUnknownError(error) }); },
      );
      return;
    }
    this.#reply({ id, version: PROTOCOL_VERSION, ok: true, value: answer });
  }

  #reply(response: unknown): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: response })));
  }

  /** Ends every scripted worker and forgets what the last test scripted. */
  static reset(): void {
    for (const worker of ScriptedWorker.instances.splice(0)) worker.terminate();
    ScriptedWorker.restore = "restored";
    ScriptedWorker.refresh = "stepped";
    ScriptedWorker.answers.clear();
  }

  terminate(): void {
    for (const port of this.#ports) port.close();
  }

  #answer(type: string, input: Record<string, unknown>): unknown {
    if(type==="initial-start-state")return {kind:"empty"};
    if(type==="initial-start-begin")return {kind:"pending",source:input["source"]};
    if(type==="initial-start-retire")return undefined;
    switch (type) {
      case "initialize":
        return this.options.name === "oxidevm-control"
          ? { execution: "serialized", vcpus: 1, sharedMemory: false }
          : undefined;
      case "inspect-start-image":return null;
      case "workspace-persistence":
        return "opfs";
      case "current-system-image":
        return { id: "alpine", version: "2026.10.02", workspaceBaseSha256: "a".repeat(64),
          runtimes: { alpine: "3.24.1", node: "24.18.1", bun: "1.3.14", next: "16.2.12" } };
      case "prepare-managed-image":
        return {
          id: "alpine",
          version: "2026.10.02",
          memoryMiB: 256,
          vcpus: 1,
          workspaceBaseSha256: "a".repeat(64),
          kernel: new Uint8Array([0x4b]),
          commandLine: "console=hvc0",
          diskBytes: 1024 * 1024,
          aot: { kind: "skipped", reason: "no-catalog" },
          runtimes: { alpine: "3.24.1", node: "24.18.1", bun: "1.3.14", next: "16.2.12" },
        };
      case "boot-system":
        this.#booted = true;
        return undefined;
      case "wait-agent":
        return { version: "7", capabilities: { files: true, processes: true } };
      case "agent-refresh-guest":
        if (ScriptedWorker.refresh === "fails") {
          throw new VMError("GUEST_CRASH", "the restored guest's clock could not be set", { reason: "clock-not-set" });
        }
        return undefined;
      case "start-system":
        if (!this.#booted) throw new VMError("INVALID_ARGUMENT", "system is not booted");
        this.#session = { id: integer(input["sessionId"], "session id", 1), port: this.#port(input) };
        return undefined;
      case "stop-system":
        this.#endSession();
        return undefined;
      case "restore":
        this.#restore();
        return { newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [] };
      case "agent-spawn":
        {
          const port = this.#port(input);
          if (input["command"] === "sync") queueMicrotask(() => port.postMessage({
            version: PROTOCOL_VERSION, type: "exit", sessionId: 1, sequence: 1,
            termination: { kind: "exit", code: 0 },
          }));
        }
        return { pid: 7, sessionId: 1 };
      case "snapshot-events":
        // Pages follow restore point events through this port; the script sends none.
        this.#port(input);
        return undefined;
      case "agent-restore-workspace":
      case "agent-sync-workspace":
        return true;
      case "network-link-connect":
      case "network-link-failed":
      case "quiesce-disk":
      case "configure-system-aot":
      case "assistance-dispose":
      case "dispose":
        return undefined;
      default:
        throw new Error(`unexpected operation ${type}`);
    }
  }

  #restore(): void {
    if (ScriptedWorker.restore === "refused") {
      throw new VMError("SNAPSHOT_VERSION", "snapshot was captured by a differently shaped VM");
    }
    if (ScriptedWorker.restore === "lost") {
      this.#booted = false;
      throw new VMError("STORAGE_ERROR", "restored RAM chunk is invalid");
    }
  }

  #port(input: Record<string, unknown>): MessagePort {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("a port was not transferred");
    this.#ports.push(port);
    return port;
  }

  #endSession(): void {
    const session = this.#session;
    this.#session = undefined;
    session?.port.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: session.id,
      sequence: 1,
      type: "exit",
      exit: { kind: "halted", steps: 0n },
    });
  }
}

export async function bootedManagedVm(ephemeral = false): Promise<RuntimeVM> {
  const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "restore", ephemeral, memoryMiB: 256, vcpus: 1, network: "local" });
  await vm.bootManagedImage("https://images.example.test/alpine/manifest.json");
  ScriptedWorker.named("oxidevm-control").operations.length = 0;
  return vm;
}
import { BrowserAssistance } from "./browser-assistance.js";

/** Use the same explicitly admitted composition as the diagnostics entry point. */
export function createAdvancedTestVM(...arguments_: Parameters<typeof createSystemRuntimeVM>): ReturnType<typeof createSystemRuntimeVM> {
  return createSystemRuntimeVM(arguments_[0], arguments_[1], (control, options) => new BrowserAssistance(control, options));
}
