import { VMError } from "../errors.js";
import type {ShippedInstallIdentity} from "../protocol/shipped-source.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { captureFileStream, restoredFileStream } from "./snapshot-file-streams.js";
import type { UserspaceSnapshotManifest } from "./snapshot-manifest.js";
import type { SnapshotObjects } from "./snapshot-objects.js";
import type { WorkspaceSelections, NativeFileSession } from "./workspace-selections.js";
import { decodeWorkspaceOverlayManifest, WorkspaceStore } from "./workspace-store.js";
import { workspaceBytesInput,type WorkspaceStreams } from "./workspace-stream.js";

type Durable = NonNullable<UserspaceSnapshotManifest["durable"]>;
export interface PreparedNativeFiles {
  readonly id:string;
  stageWorkspace(base:string,streams:WorkspaceStreams,signal:AbortSignal):Promise<number>;
  commit(signal: AbortSignal, session?: NativeFileSession,preservedId?:string,initialStart?:ShippedInstallIdentity): Promise<void>;
  abort(): Promise<void>;
}

/** Checkpoint file pins and portable streams use the existing workspace store.
 * Selection stays unpublished until the runtime replacement is ready. */
export class NativeSnapshotFiles {
  readonly #selections: WorkspaceSelections;
  readonly #objects: SnapshotObjects;

  constructor(selections: WorkspaceSelections, objects: SnapshotObjects) {
    this.#selections = selections;
    this.#objects = objects;
  }

  async capture(id: string, base: string, root: string | undefined, signal: AbortSignal,
    baseline?: Pick<UserspaceSnapshotManifest, "id" | "durable">): Promise<Durable | undefined> {
    active(signal);
    await this.#selections.retain(id, root);
    try {
      // Admission verified baseline objects; exact pinned manifests decide which streams can be reused.
      const changed = baseline !== undefined && await this.#selections.has(baseline.id)
        ? await this.#selections.differences(id, baseline.id, root, root, signal) : undefined;
      const workspace = changed?.workspace === false ? baseline?.durable?.workspace : await this.#captureWorkspace(base, signal);
      let system = root !== undefined && changed?.root === false ? baseline?.durable?.root : undefined;
      if (root !== undefined && system === undefined) {
        const store = await openUserspaceRootStore(this.#selections.backend, root);
        const lease = await store.openRead(root, signal);
        try { system = lease?.snapshot === undefined ? { bytes: 0, chunks: [] } : await captureFileStream(this.#objects, lease.snapshot, signal); }
        finally { await lease?.retire(); }
      }
      return workspace === undefined && system === undefined ? undefined
        : { ...(workspace === undefined ? {} : { workspace }), ...(system === undefined ? {} : { root: system }) };
    } catch (error) { await this.#selections.release(id); throw error; }
  }

  async #captureWorkspace(base: string, signal: AbortSignal): Promise<Durable["workspace"]> {
    const lease = await new WorkspaceStore(this.#selections.backend).openRead(base, signal);
    if (lease === undefined) return undefined;
    try {
      if (lease.snapshot === undefined || lease.delta === undefined) {
        throw new VMError("STORAGE_ERROR", "Native capture requires a completed workspace flush");
      }
      const snapshot = await captureFileStream(this.#objects, lease.snapshot, signal);
      const delta = await captureFileStream(this.#objects, lease.delta, signal);
      const dependencies = lease.dependencies === undefined ? undefined : {
        inputsSha256: lease.dependencies.inputsSha256, tree: await captureFileStream(this.#objects, lease.dependencies.tree, signal),
      };
      return { baseSha256: base, snapshot, delta, ...(dependencies === undefined ? {} : { dependencies }) };
    } finally { await lease.retire(); }
  }

  async prepare(id: string, root: string | undefined, durable: Durable | undefined, signal: AbortSignal, reads: Pick<SnapshotObjects, "read"> = this.#objects): Promise<PreparedNativeFiles> {
    active(signal);
    if ((root === undefined) !== (durable?.root === undefined)) {
      throw new VMError("SNAPSHOT_VERSION", "Native checkpoint persistence policy is incompatible");
    }
    const local=await this.#selections.has(id);if(local)await this.#selections.validate(id,signal);
    const candidate=crypto.randomUUID(),stage = await this.#selections.stage(candidate, root,local?id:undefined);
    const result:PreparedNativeFiles={...stage,id:candidate,stageWorkspace:(base,streams,signal)=>new WorkspaceStore(stage.backend).commitStreams(base,streams,signal)};
    if(local)return result;
    try {
      const workspace = durable?.workspace;
      if (workspace === undefined) await stage.backend.remove("active.json");
      else await new WorkspaceStore(stage.backend).commitStreams(workspace.baseSha256, {
        snapshot: restoredFileStream(reads, workspace.snapshot), delta: restoredFileStream(reads, workspace.delta),
        ...(workspace.dependencies === undefined ? {} : { dependencies: {
          inputsSha256: workspace.dependencies.inputsSha256, tree: restoredFileStream(reads, workspace.dependencies.tree),
        } }),
      }, signal);
      if (root !== undefined) {
        const system = durable?.root;
        if (system === undefined || system.bytes === 0) await stage.backend.remove(`userspace-roots/${root}/active.json`);
        else await (await openUserspaceRootStore(stage.backend, root)).commitStreams(root, {
          snapshot: restoredFileStream(reads, system), delta: workspaceBytesInput(new Uint8Array()),
        }, signal);
      }
      return result;
    } catch (error) { await stage.abort(); throw error; }
  }

  /** Uses a retained cold selection; no checkpoint catalogue or image closure is synthesized. */
  async prepareSelected(id: string, root: string | undefined, signal: AbortSignal): Promise<PreparedNativeFiles> {
    active(signal); await this.#selections.validate(id, signal);
    const candidate = crypto.randomUUID(), stage = await this.#selections.stage(candidate, root, id);
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
}

function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native file selection cancelled"); }

function coldWorkspaceBase(bytes:Uint8Array):string {
  try {return decodeWorkspaceOverlayManifest(JSON.parse(new TextDecoder().decode(bytes))).workspaceBaseSha256;}
  catch {throw new VMError("STORAGE_ERROR","Cold workspace metadata is damaged");}
}
