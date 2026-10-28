import { deserializeError, VMError } from "./errors.js";
import type { ControlOperations } from "./protocol.js";
import type { WorkerClient } from "./worker-client.js";
import { decodeWorkspaceChangesMessage, isFileResultOperation, type FileResult } from "./protocol/workspace-files.js";
import type { AgentFileRequest } from "./protocol/agent-files.js";
import { MAX_WORKSPACE_FILE_BYTES, type WorkspaceFileBackend } from "./workspace-files.js";
import { WorkspaceWatches } from "./workspace-watches.js";
import { retryWorkspaceBusy } from "./workspace-retry.js";

export class SystemWorkspaceFiles implements WorkspaceFileBackend {
  readonly #watches: WorkspaceWatches;
  constructor(readonly control: WorkerClient<ControlOperations>) {
    this.#watches = new WorkspaceWatches({ open: async (onChange, onFailure) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (event: MessageEvent<unknown>) => {
        try {
          const message = decodeWorkspaceChangesMessage(event.data);
          if (message.type === "failed") onFailure(deserializeError(message.error)); else onChange(message.changes);
        } catch (error) { onFailure(error); }
      };
      port1.onmessageerror = () => onFailure(new VMError("PROTOCOL_ERROR", "workspace change message could not be read"));
      try { await control.request("agent-files-watch", { port: port2 }, { transfer: [port2] }); }
      catch (error) { port1.close(); port2.close(); throw error; }
      return {
        setDirectories: async directories => { await retryWorkspaceBusy(() => control.request("agent-files-set", { directories }), control.lifetime); },
        close: async () => { port1.close(); if (!control.lifetime.aborted) await control.request("agent-files-unwatch", undefined); },
      };
    } }, control.lifetime);
  }
  async entries(path = "/", signal?: AbortSignal) { return (await this.#request({ operation: "entries", path }, signal, "entries")).entries; }
  async stat(path: string, signal?: AbortSignal) { return (await this.#request({ operation: "stat", path }, signal, "stat")).entry; }
  async read(path: string, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    const { entry, data } = await this.#request({ operation: "read", path, maxBytes: options.maxBytes ?? MAX_WORKSPACE_FILE_BYTES }, options.signal, "read");
    return { entry, data };
  }
  async write(path: string, data: Uint8Array, options: { ifVersion?: string | null; signal?: AbortSignal } = {}) {
    return (await this.#request({ operation: "write", path, data, ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }) }, options.signal, "write")).entry;
  }
  async createDirectory(path: string, options: { signal?: AbortSignal } = {}) { await this.#request({ operation: "mkdir", path }, options.signal, "mkdir"); }
  async rename(from: string, to: string, options: { signal?: AbortSignal } = {}) { await this.#request({ operation: "rename", from, to }, options.signal, "rename"); }
  watch: WorkspaceFileBackend["watch"] = (onChange, options) => this.#watches.watch(onChange, options);
  async #request<K extends FileResult["operation"]>(request: AgentFileRequest, signal: AbortSignal | undefined, operation: K): Promise<Extract<FileResult, { operation: K }>> {
    const result = await retryWorkspaceBusy(() => this.control.request("agent-files", { request }, { signal }), signal);
    if (!isFileResultOperation(result, operation)) throw new VMError("PROTOCOL_ERROR", "workspace response operation mismatch");
    return result;
  }
}
