import { VMError } from "../errors.js";
import type { WorkspaceReadRequest } from "../protocol/workspace-read.js";
import { WORKSPACE_PUBLICATION_BYTES } from "../protocol/workspace-publication.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import type { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { publishWorkspaceCaptures } from "./workspace-publication-client.js";
import { openWorkspaceRead } from "./workspace-read-client.js";
import type { WorkspaceStreamInput, WorkspaceStreams } from "./workspace-stream.js";

/** One storage channel owns one credit sequence across reads, native restores and writes. */
export class UserspaceWorkspaceTransfers {
  readonly #client: UserspaceStorageClient;
  readonly #session = crypto.randomUUID();
  readonly #traffic = new AssistanceTraffic(7);
  #generation = 0;
  constructor(client: UserspaceStorageClient) { this.#client = client; }

  begin(): number {
    if (this.#traffic.pendingEntries !== 0) throw new VMError("INVALID_ARGUMENT", "Workspace producer is still active");
    if (this.#generation === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Workspace binding generation exhausted");
    return ++this.#generation;
  }

  assert(generation: number): void {
    if (generation === 0 || generation !== this.#generation) throw new VMError("ABORTED", "Workspace producer was replaced");
  }

  async read(base: string, signal: AbortSignal, selection?: WorkspaceReadRequest["selection"]) {
    this.assert(this.#generation);
    const credit = this.#traffic.grant({ session: this.#session, generation: this.#generation, producer: "storage", process: null,
      pool: "data", bytes: WORKSPACE_PUBLICATION_BYTES, entries: 1 });
    let read: Awaited<ReturnType<typeof openWorkspaceRead>>;
    try { read = await openWorkspaceRead(this.#client, { workspaceBaseSha256: base, credit,
      ...(selection === undefined ? {} : { selection }) }, signal); }
    catch (error) {
      if (error instanceof VMError && error.detail?.["readRetired"] === true) this.#traffic.returnCredit({ ...credit, kind: "return" });
      throw error;
    }
    let retirement: Promise<void> | undefined;
    return { selection: read.selection, retire: () => retirement ??= (async () => {
      this.#traffic.returnCredit(await read.retire());
    })() };
  }

  publish(base: string, snapshot: WorkspaceStreams["snapshot"], delta: WorkspaceStreamInput, signal: AbortSignal) {
    this.assert(this.#generation);
    return publishWorkspaceCaptures((publication, signal) => this.#client.publishWorkspace(publication, signal),
      { binding: { session: this.#session, generation: this.#generation }, workspaceBaseSha256: base, snapshot, delta }, this.#traffic, signal);
  }
}
