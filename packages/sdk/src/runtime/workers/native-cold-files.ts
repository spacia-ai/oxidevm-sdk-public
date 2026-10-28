import { VMError } from "../errors.js";
import type { NativeSnapshotFiles, PreparedNativeFiles } from "./snapshot-userspace-files.js";
import type { WorkspaceSelections } from "./workspace-selections.js";

interface ColdFiles {
  readonly sourceId: string;
  readonly files: PreparedNativeFiles;
  readonly base: string;
  staged: boolean;
  preserve: boolean;
  published: boolean;
}

/** Cold migration retains the selected files and uses the existing atomic pair publication. */
export class NativeColdFiles {
  readonly #selections: WorkspaceSelections;
  readonly #files: NativeSnapshotFiles;
  #active: ColdFiles | undefined;
  #preparing: string | undefined;
  constructor(selections: WorkspaceSelections, files: NativeSnapshotFiles) { this.#selections = selections; this.#files = files; }
  get busy(): boolean { return this.#active !== undefined || this.#preparing !== undefined; }
  get retainedIds(): readonly string[] { return this.#active === undefined ? (this.#preparing===undefined?[]:[this.#preparing]) : [this.#active.sourceId, this.#active.files.id]; }
  async begin(root: string | undefined, base: string, signal: AbortSignal): Promise<string> {
    if (this.busy) invalid();
    const sourceId = crypto.randomUUID();
    this.#preparing=sourceId;
    try {
      await this.#selections.retain(sourceId, root);
      const files = await this.#files.prepareSelected(sourceId, root, signal);
      this.#active = { sourceId, files, base, staged: false, preserve: false, published: false };
      return sourceId;
    } catch (error) { await this.#selections.release(sourceId); throw error; }
    finally {this.#preparing=undefined;}
  }
  files(sourceId: string, base: string): PreparedNativeFiles {
    const current = this.#require(sourceId); if(current.base!==base)invalid(); if (current.published || current.staged) invalid(); return current.files;
  }
  staged(sourceId: string, preserve: boolean): void {
    const current = this.#require(sourceId); if (current.published || current.staged) invalid(); current.staged = true; current.preserve = preserve;
  }
  async publish(sourceId: string, signal: AbortSignal): Promise<void> {
    const current = this.#require(sourceId); if (!current.staged || current.published) invalid();
    await current.files.commit(signal, undefined, current.preserve ? sourceId : undefined);
    current.published = true;
  }
  async complete(sourceId: string): Promise<void> {
    const current = this.#require(sourceId); if (!current.published) invalid();
    this.#active = undefined;
    await this.#selections.release(current.sourceId);
  }
  async abort(sourceId?:string): Promise<void> {
    const current = this.#active; if (current === undefined) return;
    if(sourceId!==undefined&&sourceId!==current.sourceId)invalid();
    // Once the pair committed, a later native publication error cannot uncommit durable files.
    if (!current.published) await current.files.abort();
    await this.#selections.release(current.sourceId);
    this.#active = undefined;
  }
  #require(sourceId: string): ColdFiles { if (this.#active?.sourceId !== sourceId) invalid(); return this.#active; }
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Cold file selection is not in the requested phase"); }
