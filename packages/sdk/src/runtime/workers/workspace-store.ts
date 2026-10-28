import { readBuildPolicy, commitBuildPolicy, recoverBuildPolicy } from "./workspace-build-policy.js";
import type { BuildScriptDecision } from "../protocol/build-script-approval.js";
import { integer } from "../decode.js";
import { VMError } from "../errors.js";
import { encodeDelta, mergeWorkspaceDeltas } from "./workspace-delta.js";
import { retainWorkspaceRead, type WorkspaceReadLease, type WorkspaceReadSource } from "./workspace-read.js";
import { openWorkspaceStreams, readWorkspaceStream, recoverWorkspaceStaging, stageWorkspaceStream, trackWorkspaceStream, workspaceBytesInput, WorkspaceStreamStaging, type WorkspaceStreamRef, type WorkspaceStreams } from "./workspace-stream.js";

import { MAX_SNAPSHOT_BYTES, decodeWorkspaceOverlayManifest, dependencyHash, digest, droppedStreamReferences, encodeJson, parseJson, sha256, streamReferences, verifyDependencies,
  type LegacyWorkspaceManifest, type StreamWorkspaceManifest, type WorkspaceOverlayManifest } from "./workspace-manifest.js";
export { decodeWorkspaceOverlayManifest } from "./workspace-manifest.js";

export interface WorkspaceStoreBackend {
  /** Shared stream publication/recovery turn for views of the same selected files. */
  mutate?<T>(operation: () => Promise<T>): Promise<T>;
  list(prefix: string): AsyncIterable<string>;
  /** Resolve/reject only after the read producer has retired. */
  read(path: string, maximumBytes?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined>;
  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(path: string): Promise<void>;
}


/** What {@link WorkspaceStore.readOverlay} found. */
export type WorkspaceOverlayRead =
  | { readonly kind: "none" }
  | { readonly kind: "damaged" }
  | {
      readonly kind: "overlay";
      readonly workspaceBaseSha256: string;
      readonly generation: number;
      readonly snapshot?: Uint8Array<ArrayBuffer>;
      readonly delta?: Uint8Array<ArrayBuffer>;
    };

export type WorkspaceStagedPublication = {
  readonly generation: number;
  /** One bounded read lease over staged, verified immutable objects. */
  openRead(signal: AbortSignal): WorkspaceReadLease;
  commit(): Promise<number>;
  abort(): Promise<void>;
};

export class WorkspaceStore {
  readonly #backend: WorkspaceStoreBackend;
  #writing = false;
  #readers = 0;
  #failure: VMError | undefined;
  #recovery: Promise<void> | undefined;

  constructor(backend: WorkspaceStoreBackend) {
    this.#backend = backend;
  }

  /** Revisit retired stream journals after a restore-point owner releases pins. */
  collect(): Promise<void> { return this.#write(() => this.#recoverStaging()); }

  async readBuildPolicy(base: string, signal?: AbortSignal): Promise<readonly BuildScriptDecision[]> {
    this.#readers += 1;
    try { await this.#recover(); requireReadActive(signal); return await readBuildPolicy(this.#backend, base, signal); }
    finally { this.#readers -= 1; }
  }

  commitBuildPolicy(base: string, decisions: readonly BuildScriptDecision[], signal?: AbortSignal): Promise<void> {
    return this.#write(() => commitBuildPolicy(this.#backend, base, decisions, signal));
  }

  async read(workspaceBaseSha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return (await this.readGeneration(workspaceBaseSha256, signal))?.snapshot;
  }

  /**
   * The overlay's generation together with its snapshot, both from one manifest; undefined
   * before any commit. A restore point records the generation its guest matched.
   */
  async readGeneration(
    workspaceBaseSha256: string,
    signal?: AbortSignal,
  ): Promise<{ readonly generation: number; readonly snapshot: Uint8Array<ArrayBuffer> } | undefined> {
    this.#readers += 1;
    try { return await this.#read(workspaceBaseSha256, signal); }
    catch (error) {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#failure = error;
      throw error;
    }
    finally { this.#readers -= 1; }
  }

  async #read(
    workspaceBaseSha256: string,
    signal?: AbortSignal,
  ): Promise<{ readonly generation: number; readonly snapshot: Uint8Array<ArrayBuffer> } | undefined> {
    await this.#recover();
    requireReadActive(signal);
    digest(workspaceBaseSha256, "workspace base SHA-256");
    const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
    requireReadActive(signal);
    if (encoded === undefined) return undefined;
    const manifest = decodeWorkspaceOverlayManifest(parseJson(encoded));
    if (manifest.workspaceBaseSha256 !== workspaceBaseSha256) {
      throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile", {
        reason: "workspace-base-mismatch",
      });
    }
    const generation = manifest.generation;
    if (manifest.formatVersion === 2) return { generation, snapshot: await this.#collect(manifest.snapshot, signal) };
    if (manifest.snapshotSha256 === undefined || manifest.snapshotBytes === undefined) return undefined;
    return {
      generation,
      snapshot: await this.#readBlob(manifest.snapshotSha256, manifest.snapshotBytes, "workspace overlay", signal),
    };
  }

  async readDelta(workspaceBaseSha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    this.#readers += 1;
    try { return await this.#readDelta(workspaceBaseSha256, signal); }
    catch (error) {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#failure = error;
      throw error;
    }
    finally { this.#readers -= 1; }
  }

  async #readDelta(workspaceBaseSha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    await this.#recover();
    requireReadActive(signal);
    digest(workspaceBaseSha256, "workspace base SHA-256");
    const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
    requireReadActive(signal);
    if (encoded === undefined) return undefined;
    const manifest = decodeWorkspaceOverlayManifest(parseJson(encoded));
    if (manifest.workspaceBaseSha256 !== workspaceBaseSha256) {
      throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile", {
        reason: "workspace-base-mismatch",
      });
    }
    if (manifest.formatVersion === 2) return this.#collect(manifest.delta, signal);
    if (manifest.deltaSha256 === undefined || manifest.deltaBytes === undefined) {
      throw new VMError("STORAGE_ERROR", "workspace overlay requires migration before a mode switch", {
        reason: "workspace-overlay-delta-missing",
      });
    }
    return this.#readBlob(manifest.deltaSha256, manifest.deltaBytes, "workspace delta", signal);
  }

  /**
   * The active overlay whichever base it was saved on, read and verified in full, for the Userspace
   * start that reconciles it with the image it boots. `damaged` when its records are missing,
   * corrupt or undecodable; I/O failures, cancellation and size limits still throw.
   */
  async readOverlay(signal: AbortSignal): Promise<WorkspaceOverlayRead> {
    this.#readers += 1;
    try {
      try { await this.#recover(); } catch (error) { return damaged(error); }
      requireReadActive(signal);
      const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
      requireReadActive(signal);
      if (encoded === undefined) return { kind: "none" };
      try {
        const manifest = decodeWorkspaceOverlayManifest(parseJson(encoded));
        const legacy = (hash: string | undefined, bytes: number | undefined, name: string) =>
          hash === undefined || bytes === undefined ? undefined : this.#readBlob(hash, bytes, name, signal);
        const snapshot = manifest.formatVersion === 2 ? await this.#collect(manifest.snapshot, signal) : await legacy(manifest.snapshotSha256, manifest.snapshotBytes, "workspace overlay");
        const delta = manifest.formatVersion === 2 ? await this.#collect(manifest.delta, signal) : await legacy(manifest.deltaSha256, manifest.deltaBytes, "workspace delta");
        return { kind: "overlay", workspaceBaseSha256: manifest.workspaceBaseSha256, generation: manifest.generation,
          ...(snapshot === undefined ? {} : { snapshot }), ...(delta === undefined ? {} : { delta }) };
      } catch (error) { return damaged(error); }
    } finally { this.#readers -= 1; }
  }

  /**
   * Makes `delta` the whole overlay on `workspaceBaseSha256`: how a Userspace start moves a
   * workspace onto the image it boots, or sets a damaged one aside. With `preserve` (and whenever
   * a publication was left unresolved) the previous records are first kept, byte for byte, under
   * `preserved/<id>/`, which no later commit or recovery removes; the id is returned.
   */
  async replace(workspaceBaseSha256: string, delta: Uint8Array<ArrayBuffer>, preserve: boolean, signal: AbortSignal): Promise<{ readonly generation: number; readonly preserved?: string }> {
    if (this.#writing) throw new VMError("STORAGE_ERROR", "Workspace already has an active metadata writer");
    this.#writing = true;
    try {
      return await this.#mutate(async () => {
        requireCommitActive(signal);
        digest(workspaceBaseSha256, "workspace base SHA-256");
        if (delta.byteLength > MAX_SNAPSHOT_BYTES) throw new VMError("QUOTA_EXCEEDED", "workspace delta exceeds the supported size");
        const active = await this.#backend.read("active.json", 128 * 1024, signal);
        const intent = await this.#backend.read("intent.json", 128 * 1024, signal);
        let generation = 0;
        for (const bytes of [active, intent]) {
          try { if (bytes !== undefined) generation = Math.max(generation, decodeWorkspaceOverlayManifest(parseJson(bytes)).generation); }
          catch { /* A damaged record keeps its bytes below; the count continues from what decodes. */ }
        }
        let preserved: string | undefined;
        if ((preserve && active !== undefined) || intent !== undefined) {
          preserved = await this.#nextPreservedId();
          if (active !== undefined) await this.#backend.write(`preserved/${preserved}/active.json`, active);
          if (intent !== undefined) await this.#backend.write(`preserved/${preserved}/intent.json`, intent);
        }
        const deltaSha256 = await sha256(delta);
        const manifest: LegacyWorkspaceManifest = { formatVersion: 1, generation: generation + 1, workspaceBaseSha256, deltaSha256, deltaBytes: delta.byteLength };
        // Every earlier record is either superseded here or kept above, so an earlier fence is resolved.
        this.#failure = undefined;
        await this.#publishLegacy(manifest, [{ sha256: deltaSha256, bytes: delta }], signal);
        this.#recovery = undefined;
        return { generation: manifest.generation, ...(preserved === undefined ? {} : { preserved }) };
      });
    } finally { this.#writing = false; }
  }

  async #nextPreservedId(): Promise<string> {
    let last = 0;
    for await (const path of this.#backend.list("preserved/")) {
      const id = /^preserved\/([1-9][0-9]{0,8})\//u.exec(path)?.[1];
      if (id !== undefined) last = Math.max(last, Number(id));
    }
    return String(last + 1);
  }

  /** Journals the references a commit drops, so recovery can reclaim them once unreachable. Carried-over
   * references stay live and never enter the journal. */
  async #journalDropped(previous: StreamWorkspaceManifest, next: StreamWorkspaceManifest,
    journal: WorkspaceStreamStaging): Promise<void> {
    for (const ref of droppedStreamReferences(previous, next)) await trackWorkspaceStream(this.#backend, ref, journal);
  }

  /** Streams of preserved overlays: staging recovery never reclaims them. */
  async #preservedReferences(): Promise<WorkspaceStreamRef[]> {
    const references: WorkspaceStreamRef[] = [];
    for await (const path of this.#backend.list("preserved/")) {
      const bytes = path.endsWith(".json") ? await this.#backend.read(path, 128 * 1024) : undefined;
      if (bytes === undefined) continue;
      try {
        const manifest = decodeWorkspaceOverlayManifest(parseJson(bytes));
        if (manifest.formatVersion === 2) references.push(...streamReferences(manifest));
      } catch { /* A damaged record names no stream this store can follow. */ }
    }
    return references;
  }

  /**
   * Commits a whole workspace snapshot, with the delta a full-system boot applies. A streamed
   * overlay (a full-system flush) stays streamed: a commit that brings its delta becomes the next
   * streamed generation and keeps the dependency tree, as a streamed commit without one does.
   * Without a delta it is refused rather than downgraded.
   */
  async commit(
    workspaceBaseSha256: string,
    snapshot: Uint8Array<ArrayBuffer>,
    delta?: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (delta !== undefined && (await this.#activeFormat(signal)) === 2) {
      return this.commitStreams(workspaceBaseSha256, { snapshot: workspaceBytesInput(snapshot), delta: workspaceBytesInput(delta) },
        signal ?? new AbortController().signal);
    }
    return this.#write(() => this.#commit(workspaceBaseSha256, snapshot, delta, signal));
  }

  /** The active overlay's format version; undefined before any commit. */
  async #activeFormat(signal: AbortSignal | undefined): Promise<1 | 2 | undefined> {
    await this.#recover();
    const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
    return encoded === undefined ? undefined : decodeWorkspaceOverlayManifest(parseJson(encoded)).formatVersion;
  }

  async #commit(workspaceBaseSha256: string, snapshot: Uint8Array<ArrayBuffer>, delta?: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<number> {
    requireCommitActive(signal);
    digest(workspaceBaseSha256, "workspace base SHA-256");
    if (snapshot.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new VMError("QUOTA_EXCEEDED", "workspace overlay exceeds the supported snapshot size");
    }
    const currentBytes = await this.#backend.read("active.json", 128 * 1024, signal);
    const current = currentBytes === undefined
      ? undefined
      : decodeWorkspaceOverlayManifest(parseJson(currentBytes));
    if (current?.formatVersion === 2) throw new VMError("STORAGE_ERROR", "Streamed workspace cannot be downgraded by a legacy commit");
    if (current !== undefined && current.workspaceBaseSha256 !== workspaceBaseSha256) {
      throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile", {
        reason: "workspace-base-mismatch",
      });
    }
    const snapshotSha256 = await sha256(snapshot);
    const deltaSha256 = delta === undefined ? undefined : await sha256(delta);
    requireCommitActive(signal);
    if (
      current?.snapshotSha256 === snapshotSha256
      && current.snapshotBytes === snapshot.byteLength
      && current.deltaSha256 === deltaSha256
      && current.deltaBytes === delta?.byteLength
    ) {
      return current.generation;
    }
    const manifest: WorkspaceOverlayManifest = {
      formatVersion: 1,
      generation: (current?.generation ?? 0) + 1,
      workspaceBaseSha256,
      snapshotSha256,
      snapshotBytes: snapshot.byteLength,
      ...(deltaSha256 === undefined || delta === undefined
        ? {}
        : { deltaSha256, deltaBytes: delta.byteLength }),
    };
    await this.#publishLegacy(manifest, [
      { sha256: snapshotSha256, bytes: snapshot },
      ...(deltaSha256 === undefined || delta === undefined ? [] : [{ sha256: deltaSha256, bytes: delta }]),
    ], signal);
    return manifest.generation;
  }

  /**
   * "Reset to a fresh image": the workspace becomes the image's own /workspace again (base
   * `workspaceBaseSha256`): no overlay snapshot, and a delta that changes nothing. The generation moves on, so a restore point
   * from before the reset cannot match the store by its number; the old overlay's objects stay
   * until collected.
   */
  reset(workspaceBaseSha256: string, signal?: AbortSignal): Promise<number> {
    return this.#write(async () => {
      requireCommitActive(signal);
      digest(workspaceBaseSha256, "workspace base SHA-256");
      const currentBytes = await this.#backend.read("active.json", 128 * 1024, signal);
      const current = currentBytes === undefined ? undefined : decodeWorkspaceOverlayManifest(parseJson(currentBytes));
      // An overlay holds data: a delta that changes nothing leaves the image's /workspace as it is.
      const unchanged = encodeDelta([]);
      const deltaSha256 = await sha256(unchanged);
      const manifest: LegacyWorkspaceManifest = {
        formatVersion: 1,
        generation: (current?.generation ?? 0) + 1,
        workspaceBaseSha256,
        deltaSha256,
        deltaBytes: unchanged.byteLength,
      };
      await this.#publishLegacy(manifest, [{ sha256: deltaSha256, bytes: unchanged }], signal);
      return manifest.generation;
    });
  }

  async commitDelta(
    workspaceBaseSha256: string,
    delta: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#write(() => this.#commitDelta(workspaceBaseSha256, delta, signal));
  }

  async #commitDelta(workspaceBaseSha256: string, delta: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<number> {
    requireCommitActive(signal);
    digest(workspaceBaseSha256, "workspace base SHA-256");
    if (delta.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new VMError("QUOTA_EXCEEDED", "workspace delta exceeds the supported size");
    }
    const currentBytes = await this.#backend.read("active.json", 128 * 1024, signal);
    const current = currentBytes === undefined
      ? undefined
      : decodeWorkspaceOverlayManifest(parseJson(currentBytes));
    if (current?.formatVersion === 2) throw new VMError("STORAGE_ERROR", "Streamed workspace cannot be downgraded by a legacy delta");
    if (current !== undefined && current.workspaceBaseSha256 !== workspaceBaseSha256) {
      throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile", {
        reason: "workspace-base-mismatch",
      });
    }
    const priorDelta = current?.deltaSha256 === undefined || current.deltaBytes === undefined
      ? undefined
      : await this.#readBlob(current.deltaSha256, current.deltaBytes, "workspace delta", signal);
    const committedDelta = priorDelta === undefined ? delta : mergeWorkspaceDeltas(priorDelta, delta);
    if (committedDelta.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new VMError("QUOTA_EXCEEDED", "merged workspace delta exceeds the supported size");
    }
    const deltaSha256 = await sha256(committedDelta);
    requireCommitActive(signal);
    if (current?.deltaSha256 === deltaSha256 && current.deltaBytes === committedDelta.byteLength) {
      return current.generation;
    }
    const manifest: WorkspaceOverlayManifest = {
      formatVersion: 1,
      generation: (current?.generation ?? 0) + 1,
      workspaceBaseSha256,
      ...(current?.snapshotSha256 === undefined || current.snapshotBytes === undefined
        ? {}
        : { snapshotSha256: current.snapshotSha256, snapshotBytes: current.snapshotBytes }),
      deltaSha256,
      deltaBytes: committedDelta.byteLength,
    };
    await this.#publishLegacy(manifest, [{ sha256: deltaSha256, bytes: committedDelta }], signal);
    return manifest.generation;
  }

  async #publishLegacy(manifest: LegacyWorkspaceManifest,
    blobs: readonly { readonly sha256: string; readonly bytes: Uint8Array<ArrayBuffer> }[],
    signal: AbortSignal | undefined): Promise<void> {
    requireCommitActive(signal);
    const intent = encodeJson(manifest);
    let publishing = false;
    try {
      await this.#backend.write("intent.json", intent);
      for (const blob of blobs) {
        requireCommitActive(signal);
        await this.#backend.write(`blobs/${blob.sha256}`, blob.bytes.slice());
      }
      requireCommitActive(signal);
      // Once the active-pointer write begins, cancellation cannot establish
      // rollback. Await durability and preserve the actual publication outcome.
      publishing = true;
      await this.#publish(intent);
    } catch (error) {
      if (!publishing) {
        try { await this.#backend.remove("intent.json"); }
        catch {
          this.#failure = new VMError("STORAGE_ERROR", "Workspace staging cleanup failed; reopen the VM", {
            reason: "workspace-staging-cleanup-failed", cleanupFailed: true,
          });
          throw this.#failure;
        }
      }
      throw error;
    }
  }

  /** Input records retain OXRF/OXWD semantics; this owner only chunks bytes.
   * Workspace and dependency streams stage before one active pointer changes. */
  async commitStreams(base: string, streams: WorkspaceStreams, signal: AbortSignal): Promise<number> {
    return this.#commitStreams(base, streams, signal);
  }

  /** Retain the writer until native activation either succeeds or is abandoned.
   * No candidate manifest is selected by reopening after owner loss. */
  stageStreams(base: string, streams: WorkspaceStreams, signal: AbortSignal): Promise<WorkspaceStagedPublication> {
    const ready = Promise.withResolvers<WorkspaceStagedPublication>();
    const work = this.#commitStreams(base, streams, signal, async manifest => {
      const decision = Promise.withResolvers<undefined>();
      let state: "pending" | "commit" | "abort" = "pending";
      let reader: WorkspaceReadLease | undefined;
      const aborted = new VMError("ABORTED", "Staged workspace publication cancelled");
      const abort = (): void => {
        if (state !== "pending") return;
        state = "abort"; decision.reject(aborted);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      ready.resolve({ generation: manifest.generation,
        openRead: readSignal => {
          if (state !== "pending" || reader !== undefined) throw new VMError("PROTOCOL_ERROR", "Staged workspace read unavailable or already consumed");
          this.#assertWritable();
          requireReadActive(readSignal);
          this.#readers += 1;
          try { reader = this.#retainRead(manifest, readSignal); return reader; }
          catch (error) { this.#readers -= 1; throw error; }
        },
        commit: () => {
          if (state === "pending") { state = "commit"; decision.resolve(undefined); }
          return work;
        },
        abort: async () => {
          if (state === "commit") throw new VMError("PROTOCOL_ERROR", "Staged workspace commitment has already started");
          abort();
          try { await work; }
          catch (error) { if (error !== aborted) throw error; }
        },
      });
      try { await decision.promise; }
      finally {
        signal.removeEventListener("abort", abort);
        await reader?.retire();
      }
    });
    void work.catch((error: unknown) => ready.reject(error));
    return ready.promise;
  }

  async #commitStreams(base: string, streams: WorkspaceStreams, signal: AbortSignal,
    beforePublish?: (manifest: StreamWorkspaceManifest) => Promise<void>): Promise<number> {
    const opening = openWorkspaceStreams(streams, signal);
    void opening.catch(() => {});
    const retire = async (): Promise<void> => { await (await opening).retire(); };
    return this.#write(async () => {
      streams = (await opening).streams;
      digest(base, "workspace base SHA-256");
      const currentBytes = await this.#backend.read("active.json", 128 * 1024, signal);
      const current = currentBytes === undefined ? undefined : decodeWorkspaceOverlayManifest(parseJson(currentBytes));
      if (current !== undefined && current.workspaceBaseSha256 !== base) throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile");
      if (current?.formatVersion === 2) await verifyDependencies(current);
      const staging = new WorkspaceStreamStaging(this.#backend);
      const superseded = new WorkspaceStreamStaging(this.#backend);
      let publishing = false;
      let committed = false;
      try {
        let snapshot: WorkspaceStreamRef;
        if ("reuse" in streams.snapshot) {
          integer(streams.snapshot.reuse, "workspace snapshot generation", 1);
          if (current?.formatVersion !== 2 || current.generation !== streams.snapshot.reuse) {
            throw new VMError("STORAGE_ERROR", "Workspace snapshot generation no longer matches");
          }
          snapshot = current.snapshot;
        } else snapshot = await stageWorkspaceStream(this.#backend, streams.snapshot, signal, staging);
        const delta = await stageWorkspaceStream(this.#backend, streams.delta, signal, staging);
        let dependencies = current?.formatVersion === 2 ? current.dependencies : undefined;
        if (streams.dependencies !== undefined) {
          const inputsSha256 = digest(streams.dependencies.inputsSha256, "dependency inputs SHA-256");
          const tree = await stageWorkspaceStream(this.#backend, streams.dependencies.tree, signal, staging);
          dependencies = { generation: await dependencyHash(inputsSha256, tree), inputsSha256, tree };
        }
        await retire();
        const generation = (current?.generation ?? 0) + 1;
        integer(generation, "workspace generation", 1);
        const manifest: StreamWorkspaceManifest = { formatVersion: 2, generation, workspaceBaseSha256: base, snapshot, delta,
          ...(dependencies === undefined ? {} : { dependencies }) };
        if (current?.formatVersion === 2) await this.#journalDropped(current, manifest, superseded);
        const encoded = encodeJson(manifest);
        if (encoded.length > 128 * 1024) throw new VMError("QUOTA_EXCEEDED", "workspace stream metadata exceeds its bound");
        await beforePublish?.(manifest);
        await this.#backend.write("intent.json", encoded);
        if (signal.aborted) throw new VMError("ABORTED", "Workspace commit cancelled before publication");
        // Publication is the commit point. A later abort must not claim rollback.
        publishing = true;
        await this.#publish(encoded);
        committed = true;
        await staging.retire(false);
        // ponytail: defer reclamation while any reader holds a manifest. Use
        // generation-specific reader pins if measured retention warrants them.
        // Journaled objects are reconsidered by the next commit or reopening.
        if (this.#readers === 0) await recoverWorkspaceStaging(this.#backend, [...streamReferences(manifest), ...await this.#preservedReferences()]);
        return generation;
      } catch (error) {
        try { await retire(); }
        catch (failure) {
          this.#failure = failure instanceof VMError ? failure : new VMError("STORAGE_ERROR", "Workspace producer retirement failed", { cleanupFailed: true });
          throw this.#failure;
        }
        if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) {
          // A producer may still own a read or frame. Preserve its staging
          // records and keep this owner fenced until external recovery.
          this.#failure = error;
          throw error;
        }
        // An uncertain active-pointer write may have committed. Never remove
        // its objects; later reference-aware reclamation must establish reachability.
        try {
          if (!publishing) {
            await this.#backend.remove("intent.json");
            await superseded.retire(false);
            await staging.retire(true);
          }
        }
        catch {
          this.#failure = new VMError(error instanceof VMError ? error.code : "STORAGE_ERROR",
            error instanceof Error ? error.message : "Workspace staging failed",
            { ...(error instanceof VMError ? error.detail : {}), cleanupFailed: true });
          throw this.#failure;
        }
        if (publishing) {
          this.#failure = new VMError("STORAGE_ERROR",
            error instanceof Error ? error.message : "Workspace publication outcome is uncertain",
            committed ? { reason: "workspace-reclamation-failed", committed: true }
              : { reason: "workspace-publication-uncertain" });
          throw this.#failure;
        }
        throw error;
      }
    }, retire);
  }

  async *readStream(base: string, kind: "snapshot" | "delta" | "dependencies", signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    const lease = await this.openRead(base, signal);
    if (lease === undefined) return;
    try {
      const stream = kind === "dependencies" ? lease.dependencies?.tree : lease[kind];
      if (stream !== undefined) yield* stream.source(signal).frames;
    } finally { await lease.retire(); }
  }

  async openRead(base: string, signal: AbortSignal): Promise<WorkspaceReadLease | undefined> {
    this.#readers += 1;
    let retained = false;
    try {
      await this.#recover();
      this.#assertWritable();
      requireRestoreActive(signal);
      digest(base, "workspace base SHA-256");
      const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
      requireRestoreActive(signal);
      if (encoded === undefined) return undefined;
      const manifest = decodeWorkspaceOverlayManifest(parseJson(encoded));
      if (manifest.workspaceBaseSha256 !== base) throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile");
      if (manifest.formatVersion === 2) await verifyDependencies(manifest);
      requireRestoreActive(signal);
      this.#assertWritable();
      const lease = this.#retainRead(manifest, signal);
      retained = true;
      return lease;
    }
    catch (error) {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#failure = error;
      throw error;
    }
    finally { if (!retained) this.#readers -= 1; }
  }

  /** The selection owner already pins this immutable manifest and its objects.
   * Its read lease must not recover journals belonging to the current writer. */
  async openRetainedRead(manifest: WorkspaceOverlayManifest, signal: AbortSignal): Promise<WorkspaceReadLease> {
    requireRestoreActive(signal);
    if (manifest.formatVersion === 2) await verifyDependencies(manifest);
    requireRestoreActive(signal);
    this.#readers += 1;
    try { return this.#retainRead(manifest, signal); }
    catch (error) { this.#readers -= 1; throw error; }
  }

  #retainRead(manifest: WorkspaceOverlayManifest, signal: AbortSignal): WorkspaceReadLease {
      const stream = (ref: WorkspaceStreamRef): WorkspaceReadSource => ({ bytes: ref.bytes,
        read: signal => readWorkspaceStream(this.#backend, ref, signal) });
      const legacy = (hash: string | undefined, bytes: number | undefined): WorkspaceReadSource | undefined =>
        hash === undefined || bytes === undefined ? undefined : { bytes,
          read: signal => this.#readLegacyStream(hash, bytes, signal) };
      const snapshot = manifest.formatVersion === 2 ? stream(manifest.snapshot) : legacy(manifest.snapshotSha256, manifest.snapshotBytes);
      const delta = manifest.formatVersion === 2 ? stream(manifest.delta) : legacy(manifest.deltaSha256, manifest.deltaBytes);
      const dependencies = manifest.formatVersion === 2 ? manifest.dependencies : undefined;
      return retainWorkspaceRead({ generation: manifest.generation,
        ...(snapshot === undefined ? {} : { snapshot }), ...(delta === undefined ? {} : { delta }),
        ...(dependencies === undefined ? {} : { dependencies: { generation: dependencies.generation,
          inputsSha256: dependencies.inputsSha256, tree: stream(dependencies.tree) } }),
      }, signal, () => { this.#readers -= 1; }, error => { this.#failure ??= error; });
  }

  async *#readLegacyStream(hash: string, size: number, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
    const bytes = await this.#readBlob(hash, size, "workspace restore", signal);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      requireRestoreActive(signal);
      yield bytes.slice(offset, offset + 64 * 1024);
    }
  }

  async dependencyGeneration(base: string, signal: AbortSignal): Promise<string | undefined> {
    await this.#recover();
    this.#assertWritable();
    requireReadActive(signal);
    digest(base, "workspace base SHA-256");
    const encoded = await this.#backend.read("active.json", 128 * 1024, signal);
    requireReadActive(signal);
    if (encoded === undefined) return undefined;
    const manifest = decodeWorkspaceOverlayManifest(parseJson(encoded));
    if (manifest.workspaceBaseSha256 !== base) throw new VMError("STORAGE_ERROR", "workspace overlay base does not match the managed profile");
    if (manifest.formatVersion !== 2) return undefined;
    await verifyDependencies(manifest);
    requireReadActive(signal);
    this.#assertWritable();
    return manifest.dependencies?.generation;
  }

  async #collect(ref: WorkspaceStreamRef, signal = new AbortController().signal): Promise<Uint8Array<ArrayBuffer>> {
    if (ref.bytes > MAX_SNAPSHOT_BYTES) throw new VMError("QUOTA_EXCEEDED", "Workspace requires streamed restore; legacy buffer limit is 128 MiB");
    const bytes = new Uint8Array(ref.bytes);
    let offset = 0;
    for await (const chunk of readWorkspaceStream(this.#backend, ref, signal)) {
      bytes.set(chunk, offset); offset += chunk.length;
    }
    return bytes;
  }

  async #write<T>(operation: () => Promise<T>, retire?: () => Promise<void>): Promise<T> {
    let acquired = false;
    try {
      this.#assertWritable();
      if (this.#writing) throw new VMError("STORAGE_ERROR", "Workspace already has an active metadata writer");
      this.#writing = acquired = true;
      return await this.#mutate(async () => {
        await this.#recoverOnce();
        this.#assertWritable();
        const result = await operation();
        await retire?.();
        return result;
      });
    } catch (error) {
      try { await retire?.(); }
      catch (failure) {
        this.#failure = failure instanceof VMError ? failure : new VMError("STORAGE_ERROR", "Workspace producer retirement failed", { cleanupFailed: true });
        throw this.#failure;
      }
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#failure = error;
      throw error;
    } finally { if (acquired) this.#writing = false; }
  }

  #assertWritable(): void { if (this.#failure !== undefined) throw this.#failure; }

  async #publish(encoded: Uint8Array<ArrayBuffer>): Promise<void> {
    this.#assertWritable();
    let committed = false;
    try {
      await this.#backend.write("active.json", encoded);
      committed = true;
      await this.#backend.remove("intent.json");
    } catch (error) {
      this.#failure = new VMError("STORAGE_ERROR",
        error instanceof Error ? error.message : "Workspace publication outcome is uncertain",
        committed
          ? { reason: "workspace-publication-cleanup-failed", committed: true, cleanupFailed: true }
          : { reason: "workspace-publication-uncertain" });
      throw this.#failure;
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#backend.mutate === undefined ? operation() : this.#backend.mutate(operation);
  }

  #recover(): Promise<void> { return this.#mutate(() => this.#recoverOnce()); }

  #recoverOnce(): Promise<void> {
    this.#recovery ??= this.#recoverStaging();
    return this.#recovery;
  }

  async #recoverStaging(): Promise<void> {
    await recoverBuildPolicy(this.#backend);
    const active = await this.#backend.read("active.json", 128 * 1024);
    const intent = await this.#backend.read("intent.json", 128 * 1024);
    const manifest = active === undefined ? undefined : decodeWorkspaceOverlayManifest(parseJson(active));
    if (manifest?.formatVersion === 2) await verifyDependencies(manifest);
    if (intent !== undefined) {
      decodeWorkspaceOverlayManifest(parseJson(intent));
      if (active === undefined || active.length !== intent.length || !active.every((byte, index) => byte === intent[index])) {
        // Preserve both the selected state and every unresolved publication object.
        this.#failure = new VMError("STORAGE_ERROR", "Workspace publication requires recovery before further writes", { reason: "workspace-publication-uncertain" });
        return;
      }
      if (manifest?.formatVersion === 2) {
        for (const ref of streamReferences(manifest)) {
          for await (const chunk of readWorkspaceStream(this.#backend, ref, new AbortController().signal)) void chunk;
        }
      } else if (manifest !== undefined) {
        if (manifest.snapshotSha256 !== undefined && manifest.snapshotBytes !== undefined) await this.#readBlob(manifest.snapshotSha256, manifest.snapshotBytes, "snapshot");
        if (manifest.deltaSha256 !== undefined && manifest.deltaBytes !== undefined) await this.#readBlob(manifest.deltaSha256, manifest.deltaBytes, "delta");
      }
      await this.#backend.remove("intent.json");
    }
    await recoverWorkspaceStaging(this.#backend, [...manifest?.formatVersion === 2 ? streamReferences(manifest) : [], ...await this.#preservedReferences()]);
  }


  async #readBlob(
    sha256Value: string,
    bytes: number,
    name: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const value = await this.#backend.read(`blobs/${sha256Value}`, bytes, signal);
    requireReadActive(signal);
    if (value === undefined || value.byteLength !== bytes || await sha256(value) !== sha256Value) {
      throw new VMError("STORAGE_ERROR", `${name} blob is missing or corrupt`, {
        reason: "workspace-overlay-corrupt",
      });
    }
    requireReadActive(signal);
    return value;
  }
}

/** Validation failures of the overlay's own records make it damaged; anything else propagates. */
function damaged(error: unknown): { readonly kind: "damaged" } {
  if (error instanceof VMError && (error.code === "STORAGE_ERROR" || error.code === "PROTOCOL_ERROR") && error.detail?.["cleanupFailed"] !== true) {
    return { kind: "damaged" };
  }
  throw error;
}

function requireRestoreActive(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "Workspace restore cancelled");
}

function requireCommitActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Workspace commit cancelled before publication");
}

function requireReadActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Workspace read cancelled");
}
