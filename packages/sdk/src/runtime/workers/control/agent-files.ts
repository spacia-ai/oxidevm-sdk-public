import { AGENT_FILE_KINDS, decodeAgentFileChanges, decodeAgentFileEntries, decodeAgentFileEntry, decodeAgentFileRead, decodeAgentFileUnit, decodeAgentFileWrite, encodeAgentFileRequest, encodeAgentFileWatch, type AgentFileRequest } from "../../protocol/agent-files.js";
import { serializeUnknownError, VMError } from "../../errors.js";
import { filesUnavailable } from "../../workspace-files.js";
import type { FileResult, WorkspaceChangesMessage } from "../../protocol/workspace-files.js";
import type { ListenerAgentPort } from "./agent-listeners.js";

/** The existing guest request transport; this owner adds no execution pump. */
interface FileAgentPort extends ListenerAgentPort {
  request(workerId: number, kind: number, payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

export class AgentFiles {
  #supported: boolean | undefined;
  #page: MessagePort | undefined;
  #directories: readonly string[] = [];
  #subscription = 0;
  #lastSubscription = 0;
  #generation = 0;
  #requests: Promise<unknown> = Promise.resolve();
  constructor(readonly agent: FileAgentPort) {}

  get draining(): boolean { return this.#subscription !== 0; }

  async execute(workerId: number, request: AgentFileRequest): Promise<FileResult> {
    this.#requireSupport();
    const payload = await this.agent.request(workerId, AGENT_FILE_KINDS[request.operation], encodeAgentFileRequest(request));
    switch (request.operation) {
      case "entries": return { operation: "entries", ...decodeAgentFileEntries(payload, request.path) };
      case "stat": return { operation: "stat", entry: decodeAgentFileEntry(payload, request.path) };
      case "read": return { operation: "read", ...decodeAgentFileRead(payload, request.path, request.maxBytes) };
      case "write": return { operation: "write", entry: decodeAgentFileWrite(payload, request.path) };
      case "mkdir": case "rename": decodeAgentFileUnit(payload, request.operation); return { operation: request.operation };
    }
  }

  watch(port: MessagePort): void {
    if (this.#supported === false) { port.close(); throw filesUnavailable(); }
    this.#page?.close(); this.#page = port;
  }

  setDirectories(directories: readonly string[]): Promise<void> {
    const payload = encodeAgentFileWatch(directories);
    const generation = this.#generation;
    const sent = this.#requests.then(async () => {
      if (generation !== this.#generation) throw new VMError("ABORTED", "workspace watch generation changed");
      this.#requireSupport();
      const previous = { directories: this.#directories, subscription: this.#subscription };
      const begun = this.agent.begin(payload);
      this.#directories = directories.slice();
      this.#subscription = begun.id; this.#lastSubscription = begun.id;
      try { await begun.reply; } catch (error) {
        if (generation === this.#generation) { this.#directories = previous.directories; this.#subscription = previous.subscription; }
        throw error;
      }
    });
    this.#requests = sent.catch(() => undefined);
    return sent;
  }

  unwatch(): void {
    this.#page?.close(); this.#page = undefined; this.#directories = [];
    const generation = this.#generation;
    const stopped = this.#requests.then(async () => {
      if (generation !== this.#generation || this.#supported !== true) return;
      const begun = this.agent.begin(encodeAgentFileWatch(null));
      this.#subscription = 0; this.#lastSubscription = begun.id;
      await begun.reply;
    });
    this.#requests = stopped.catch(() => undefined);
  }

  agentReady(supported: boolean): void {
    this.#supported = supported;
    if (!supported) { this.fail(filesUnavailable()); return; }
    if (this.#page !== undefined && this.#directories.length > 0) {
      void this.setDirectories(this.#directories).then(() => this.#post({ type: "changes", changes: [{ kind: "rescan" }] }), (error: unknown) => this.fail(error));
    }
  }

  agentGone(reason: "replaced" | "resumed" | "restarted"): void {
    this.#generation++; this.#supported = undefined; this.#subscription = 0; this.#requests = Promise.resolve();
    this.#post({ type: "changes", changes: [{ kind: "rescan" }] });
    if (reason === "restarted" && this.#page !== undefined) void Promise.resolve().then(() => this.agent.greet()).catch((error: unknown) => this.fail(error));
  }

  receive(id: number, payload: Uint8Array, error?: VMError): void {
    if (id !== this.#subscription) {
      if (id <= this.#lastSubscription || this.agent.belowFloor(id)) { this.agent.dropped(); return; }
      throw new VMError("PROTOCOL_ERROR", "unrequested workspace changes subscription");
    }
    if (error !== undefined) { this.fail(error); return; }
    try { this.#post({ type: "changes", changes: decodeAgentFileChanges(payload, this.#directories) }); }
    catch (error) { this.fail(error); }
  }

  fail(error: unknown): void {
    this.#post({ type: "failed", error: serializeUnknownError(error) });
    this.unwatch();
  }
  #post(message: WorkspaceChangesMessage): void { this.#page?.postMessage(message); }
  #requireSupport(): void {
    if (this.#supported !== true) throw this.#supported === false ? filesUnavailable() : new VMError("FEATURE_NOT_AVAILABLE", "the guest agent has not started yet", { reason: "agent-not-ready" });
  }
}
