import { VMError } from "../errors.js";
import type { AssistanceBinding } from "../protocol/assistance.js";
import type { UserspaceStorageRequest, UserspaceStorageValue } from "./userspace-storage-channel.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { WorkspaceReadSession } from "./workspace-read-session.js";
import type { WorkspaceStore, WorkspaceStoreBackend } from "./workspace-store.js";
import { openWorkspaceStreams, workspaceBytesInput } from "./workspace-stream.js";
import { receiveWorkspaceStream } from "./workspace-transfer.js";

/** One storage channel selects an exact root identity. WorkspaceStore owns
 * publication and recovery; the read session owns bounded pulls and retirement. */
export class UserspaceRootStorage {
  readonly #backend: WorkspaceStoreBackend;
  #selected: { readonly identity: string; readonly binding: AssistanceBinding; readonly store: WorkspaceStore } | undefined;
  #read: { readonly id: number; readonly session: WorkspaceReadSession } | undefined;
  #sequence = 0;
  #lastTransfer = 0;

  constructor(backend: WorkspaceStoreBackend) { this.#backend = backend; }

  async handle(request: UserspaceStorageRequest, signal: AbortSignal): Promise<UserspaceStorageValue> {
    switch (request.type) {
      case "open-root-overlay": {
        if (this.#read !== undefined) return invalid("Root read is already active");
        const previous = this.#selected;
        if (request.previous !== undefined) {
          if (previous === undefined || !sameBinding(previous.binding, request.previous)
            || request.binding.session !== request.previous.session
            || request.binding.generation !== request.previous.generation + 1) return invalid("Stale root selection transition");
        } else if (previous !== undefined && (previous.identity !== request.rootTreeSha256
          || !sameBinding(previous.binding, request.binding))) return invalid("Root selection changed within a storage channel");
        const selected = request.previous !== undefined || previous === undefined
          ? { identity: request.rootTreeSha256, binding: request.binding,
            store: await openUserspaceRootStore(this.#backend, request.rootTreeSha256) }
          : previous;
        const publish = () => {
          this.#selected = selected;
          if (request.previous !== undefined) this.#lastTransfer = 0;
        };
        const session = new WorkspaceReadSession(signal => selected.store.openRead(selected.identity, signal), signal);
        try {
          const read = await session.selection();
          if (read === undefined) { await session.retire(); publish(); return undefined; }
          if (read.snapshot === undefined || read.snapshot === 0 || read.delta !== 0 || read.dependencies !== undefined
            || this.#sequence === Number.MAX_SAFE_INTEGER) return invalid("Root generation has an invalid stream selection");
          const id = ++this.#sequence;
          this.#read = { id, session };
          publish();
          return { kind: "root-overlay", id, generation: read.generation, bytes: read.snapshot };
        } catch (error) { await session.retire(); throw error; }
      }
      case "read-root-overlay":
        return this.#reader(request.readId).read("snapshot", request.offset, signal);
      case "close-root-overlay":
        await this.#reader(request.readId).retire();
        this.#read = undefined;
        return undefined;
      case "commit-root-overlay": {
        // Own retirement before admission, including stale and cancelled requests.
        const input = receiveWorkspaceStream(request.input, request.input.binding, request.input.transfer);
        const opened = await openWorkspaceStreams({ snapshot: input, delta: workspaceBytesInput(new Uint8Array()) }, signal);
        try {
          const selected = this.#selected;
          if (selected === undefined || selected.identity !== request.rootTreeSha256
            || request.input.binding.session !== selected.binding.session || request.input.binding.generation !== selected.binding.generation
            || request.input.transfer <= this.#lastTransfer || request.input.bytes === 0) return invalid("Stale or unselected root publication");
          this.#lastTransfer = request.input.transfer;
          return await selected.store.commitStreams(selected.identity, opened.streams, signal);
        } finally { await opened.retire(); }
      }
      case "read-rootfs":
      case "workspace":
      case "read-workspace":
      case "write-workspace":
      case "read-workspace-snapshot":
      case "read-workspace-delta":
      case "commit-workspace-snapshot":
      case "read-acceleration-knowledge":
      case "write-acceleration-knowledge": return invalid("Operation does not belong to root storage");
    }
  }

  async close(): Promise<void> { await this.#read?.session.retire(); this.#read = undefined; }

  #reader(id: number): WorkspaceReadSession {
    if (this.#read?.id !== id) return invalid("Stale root read identity");
    return this.#read.session;
  }
}

function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

function sameBinding(left: AssistanceBinding, right: AssistanceBinding): boolean {
  return left.session === right.session && left.generation === right.generation;
}
