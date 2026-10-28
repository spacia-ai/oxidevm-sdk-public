import type { UserspaceWorkspaceStart } from "../../protocol/workspace-start.js";
import type { ResumedWorkspace } from "../../protocol.js";
import type { CheckpointRaw } from "./raw.js";
import { FRAME_BYTES, invalid } from "./stream.js";

export interface NativeWorkspaceReconciled { readonly workspace:ResumedWorkspace; readonly workspaceDetails:UserspaceWorkspaceStart }
export type ReconcileSource = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface ReconcileHost { readonly source:0|5; readonly identity: bigint; readonly path: string; readonly length: number; readonly sha256: string }
type State = "indexing" | "planned" | "applying" | "ended" | "failed";
type Raw = Pick<CheckpointRaw, "stage" | "u64" | "ok" | "frame">;
const MAX_ENTRIES = 64 * 1024 * 1024 / 64;

/** Rust decides conflicts, inode topology and writes. This owner only frames bounded input. */
export class UserspaceReconcile {
  readonly #raw: Raw; readonly #token: bigint; readonly #id: bigint;readonly #preservedId:string;
  #state: State = "indexing";
  constructor(raw: Raw, token: bigint, snapshot: string,preservedId=snapshot) {
    this.#preservedId=preservedId;
    this.#raw = raw; this.#token = token;
    if (!/^[a-zA-Z0-9-]{1,64}$/u.test(snapshot)) invalid("Invalid workspace reconciliation identity");
    const bytes = new TextEncoder().encode(snapshot); raw.stage(bytes);
    this.#id = raw.u64("reconcile_begin", token, bytes.length);
    if (this.#id === 0n) invalid("Native workspace reconciliation could not begin");
  }
  source(source: ReconcileSource, length: number): void {
    this.#in("indexing"); size(length, 12); this.#ok("source", source, BigInt(length));
  }
  feed(bytes: Uint8Array): void { this.#in("indexing"); this.#feed("feed", bytes); }
  sourceComplete(): void { this.#in("indexing"); this.#ok("source_complete"); }
  plan(): { readonly sources: readonly ReconcileSource[]; readonly hosts: number } {
    this.#in("indexing");
    return this.#guard(() => {
      this.#ok("plan"); const bytes = this.#raw.frame();
      if (bytes.length !== 8) invalid("Invalid native reconciliation requirements");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), mask = view.getUint32(0, true), hosts = view.getUint32(4, true);
      if ((mask & ~63) !== 0 || hosts > MAX_ENTRIES) invalid("Native reconciliation requirements exceed their bound");
      const sources: ReconcileSource[] = [0, 1, 2, 3, 4, 5];
      this.#state = "planned"; return { sources: sources.filter(source => (mask & (1 << source)) !== 0), hosts };
    });
  }
  host(index: number): ReconcileHost {
    if (this.#state !== "planned" && this.#state !== "applying") invalid("Workspace reconciliation phase is invalid");
    return this.#guard(() => {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_ENTRIES) invalid("Invalid reconciliation host index");
      this.#ok("host", index); const bytes = this.#raw.frame();
      if (bytes.length < 57 || bytes.length > 4152) invalid("Invalid native reconciliation host file");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), identity = view.getBigUint64(0, true), length = Number(view.getBigUint64(8, true));
      if (identity === 0n || view.getUint32(52, true) !== bytes.length - 56) invalid("Invalid reconciliation host identity");
      const source=view.getUint32(48,true);if(source!==0&&source!==5)invalid("Invalid reconciliation host source");
      size(length, 0); const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(56));
      if (!path.startsWith("/workspace/") || path.includes("\0")) invalid("Invalid reconciliation host path");
      return { source, identity, length, path, sha256: [...bytes.subarray(16, 48)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
    });
  }
  apply(): void { this.#in("planned"); this.#ok("apply"); this.#state = "applying"; }
  replay(source: ReconcileSource): void { this.#in("applying"); this.#ok("replay", source); }
  replayFeed(bytes: Uint8Array): void { this.#in("applying"); this.#feed("replay_feed", bytes); }
  replayComplete(): void { this.#in("applying"); this.#ok("replay_complete"); }
  hostFeed(identity: bigint, offset: number, bytes: Uint8Array): void {
    this.#in("applying"); size(offset, 0); this.#feed("host_feed", bytes, identity, BigInt(offset));
  }
  hostComplete(identity: bigint): void { this.#in("applying"); this.#ok("host_complete", identity); }
  finish(): NativeWorkspaceReconciled {
    this.#in("applying");
    return this.#guard(() => {
      this.#ok("finish"); const bytes = this.#raw.frame();
      if (bytes.length !== 20) invalid("Invalid native reconciliation result");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), changed = view.getUint32(0, true), conflicts = view.getUint32(4, true), count = view.getUint32(8, true), reported=view.getUint32(12,true),preserved=view.getUint32(16,true);
      if (preserved>2 || changed > 1 || conflicts > MAX_ENTRIES || count > MAX_ENTRIES || reported!==Math.min(conflicts+count,256)) invalid("Native reconciliation result exceeds its bound");
      const unresolved: string[] = [];
      for (let index = 0; index < count; index++) {
        this.#ok("unresolved", index); const path = this.#raw.frame();
        if (path.length === 0 || path.length > 4096) invalid("Invalid unresolved workspace path");
        unresolved.push(new TextDecoder("utf-8", { fatal: true }).decode(path));
      }
      const details:UserspaceWorkspaceStart["conflicts"][number][]=[];
      for(let index=0;index<reported;index++) {
        this.#ok("conflict",index);const bytes=this.#raw.frame();
        if(bytes.length<5||bytes.length>4100)invalid("Invalid native reconciliation conflict");
        const reason=["changed-in-both","base-unknown","content-unavailable"] as const;const decoded=reason[new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true)];if(decoded===undefined)invalid("Unknown native reconciliation conflict reason");
        details.push({reason:decoded,path:new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(4))});
      }
      this.#ok("retire"); this.#state = "ended";
      const state=preserved!==0 || conflicts !== 0 || count !== 0 ? "conflict-preserved" : changed === 1 ? "reconciled" : "in-sync";
      return {workspace:{workspace:state,unresolved},workspaceDetails:{state,conflicts:details,omittedConflicts:conflicts+count-reported,...(preserved===0?{}:{preserved:{id:this.#preservedId,reason:preserved===1?"base-unavailable" as const:"content-unavailable" as const}})}};
    });
  }
  #feed(operation: string, bytes: Uint8Array, ...arguments_: readonly (number | bigint)[]): void {
    this.#guard(() => {
      if (bytes.length === 0 || bytes.length > FRAME_BYTES) invalid("Workspace reconciliation frame exceeds its bound");
      this.#raw.stage(bytes); this.#ok(operation, ...arguments_, bytes.length);
    });
  }
  #ok(operation: string, ...arguments_: readonly (number | bigint)[]): void {
    this.#guard(() => { this.#raw.ok(`reconcile_${operation}`, this.#token, this.#id, ...arguments_); });
  }
  #guard<T>(operation: () => T): T { try { return operation(); } catch (error) { this.#state = "failed"; throw error; } }
  #in(expected: State): void { if (this.#state !== expected) invalid("Workspace reconciliation phase is invalid"); }
}
function size(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 1024 ** 4) invalid("Workspace reconciliation length is invalid");
}
