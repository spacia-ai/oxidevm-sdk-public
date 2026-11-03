import { VMError } from "../errors.js";
import type { ManagedBoot } from "../protocol/storage.js";
import type { WorkspacePublicationResult } from "../protocol/workspace-publication.js";
import { stageNativeWorkspace } from "./native-workspace-stage.js";
import type { RootfsStore } from "./rootfs-store.js";
import type { NativeSnapshotStorageRequest } from "./snapshot-native-channel.js";
import type { PreparedNativeFiles } from "./snapshot-userspace-files.js";
import type { WorkspaceSelections } from "./workspace-selections.js";
import { decodeWorkspaceOverlayManifest, WorkspaceStore } from "./workspace-store.js";

/** What a cold start needs: the workspace's file selections and the verified image. No restore-point storage. */
export interface NativeColdEnvironment {
  readonly workspaceId: string;
  readonly selections: WorkspaceSelections;
  readonly rootfs: Pick<RootfsStore, "pinImage" | "releaseCheckpoint" | "currentRootfs" | "beginCheckpointVerification">;
}
export interface NativeColdSelection { readonly boot: ManagedBoot; readonly rootTreeSha256: string; readonly rootPersistence: "ephemeral" | "persistent" }
export type NativeColdRequest = Extract<NativeSnapshotStorageRequest, { readonly type: "stage-native-cold-workspace" | "publish-native-cold" | "complete-native-cold" }>;

interface ColdFiles {
  readonly sourceId: string;
  readonly files: PreparedNativeFiles;
  readonly base: string;
  staged: boolean;
  preserve: boolean;
  published: boolean;
}

/**
 * A Userspace cold start: it selects the boot's files, retains them and publishes the reconciled pair through the
 * existing atomic selection. It needs only the workspace selections and the verified image, so it works on every
 * workspace backend, the IndexedDB fallback included; restore points are a separate owner.
 */
export class NativeColdFiles {
  readonly #environment: NativeColdEnvironment;
  #active: ColdFiles | undefined;
  #preparing: string | undefined;
  #selecting = false;
  constructor(environment: NativeColdEnvironment) { this.#environment = environment; }
  get busy(): boolean { return this.#active !== undefined || this.#preparing !== undefined || this.#selecting; }
  get retainedIds(): readonly string[] { return this.#active === undefined ? (this.#preparing===undefined?[]:[this.#preparing]) : [this.#active.sourceId, this.#active.files.id]; }

  /** Pins the verified image for this boot, records the boot's selection and retains its files. */
  async select(request: NativeColdSelection, signal: AbortSignal): Promise<{ readonly sourceId: string; readonly replaced?: string }> {
    if (this.busy) invalid(); active(signal); this.#selecting = true;
    const { selections, rootfs } = this.#environment, image = crypto.randomUUID();
    let committed = false;
    try {
      const previous = await selections.session();
      const retire = await rootfs.beginCheckpointVerification(signal);
      let saved: Awaited<ReturnType<typeof rootfs.pinImage>>;
      try { saved = await rootfs.pinImage(this.#owner(image)); active(signal); } finally { retire(); }
      if (saved.rootfs.rootTreeSha256 !== request.rootTreeSha256) throw new VMError("STORAGE_ERROR", "Cold-start image differs from its verified source");
      const result = await selections.selectBoot(request.boot, request.rootTreeSha256, image, signal);
      committed = true;
      if (previous?.image !== undefined) await rootfs.releaseCheckpoint(this.#owner(previous.image)).catch(() => {});
      this.#selecting = false;
      const sourceId = await this.begin(request.rootPersistence === "persistent" ? request.rootTreeSha256 : undefined, rootfs.currentRootfs().workspaceBaseSha256 ?? request.rootTreeSha256, signal);
      return { ...result, sourceId };
    } finally { this.#selecting = false; if (!committed) await rootfs.releaseCheckpoint(this.#owner(image)); }
  }

  async begin(root: string | undefined, base: string, signal: AbortSignal): Promise<string> {
    if (this.busy) invalid();
    const sourceId = crypto.randomUUID();
    this.#preparing=sourceId;
    try {
      await this.#environment.selections.retain(sourceId, root);
      const files = await this.#prepare(sourceId, root, signal);
      this.#active = { sourceId, files, base, staged: false, preserve: false, published: false };
      return sourceId;
    } catch (error) { await this.#environment.selections.release(sourceId); throw error; }
    finally {this.#preparing=undefined;}
  }

  handle(request: NativeColdRequest, signal: AbortSignal): Promise<WorkspacePublicationResult | undefined> {
    switch (request.type) {
      case "stage-native-cold-workspace": return this.#stage(request, signal);
      case "publish-native-cold": return this.publish(request.sourceId, signal).then(() => undefined);
      case "complete-native-cold": return this.complete(request.sourceId).then(() => undefined);
    }
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
    await this.#environment.selections.release(current.sourceId);
  }
  async abort(sourceId?:string): Promise<void> {
    const current = this.#active; if (current === undefined) return;
    if(sourceId!==undefined&&sourceId!==current.sourceId)invalid();
    // Once the pair committed, a later native publication error cannot uncommit durable files.
    if (!current.published) await current.files.abort();
    await this.#environment.selections.release(current.sourceId);
    this.#active = undefined;
  }

  async #stage(request: Extract<NativeColdRequest, { readonly type: "stage-native-cold-workspace" }>, signal: AbortSignal): Promise<WorkspacePublicationResult> {
    const result = await stageNativeWorkspace(() => this.files(request.sourceId, request.publication.workspaceBaseSha256), request.publication, signal);
    if (result.retired && result.outcome.kind === "committed") this.staged(request.sourceId, request.preserve);
    return result;
  }

  /** Uses the retained cold selection; no checkpoint catalogue or image closure is synthesized. */
  async #prepare(id: string, root: string | undefined, signal: AbortSignal): Promise<PreparedNativeFiles> {
    active(signal); await this.#environment.selections.validate(id, signal);
    const candidate = crypto.randomUUID(), stage = await this.#environment.selections.stage(candidate, root, id);
    return { ...stage, id: candidate, stageWorkspace: async (base, streams, signal) => {
      // The original foreign generation remains pinned by id. Only the private
      // candidate's workspace scope changes base; its selected root stays intact.
      const encoded = await stage.backend.read("active.json", 128 * 1024, signal);
      if (encoded !== undefined && coldWorkspaceBase(encoded) !== base) {
        await stage.backend.remove("active.json");
      }
      return new WorkspaceStore(stage.backend).commitStreams(base, streams, signal);
    } };
  }
  #owner(snapshotId: string) { return { workspaceId: this.#environment.workspaceId, snapshotId }; }
  #require(sourceId: string): ColdFiles { if (this.#active?.sourceId !== sourceId) invalid(); return this.#active; }
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Cold file selection is not in the requested phase"); }
function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native file selection cancelled"); }

function coldWorkspaceBase(bytes:Uint8Array):string {
  try {return decodeWorkspaceOverlayManifest(JSON.parse(new TextDecoder().decode(bytes))).workspaceBaseSha256;}
  catch {throw new VMError("STORAGE_ERROR","Cold workspace metadata is damaged");}
}
