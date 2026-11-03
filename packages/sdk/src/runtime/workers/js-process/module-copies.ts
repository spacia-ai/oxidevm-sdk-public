import { VMError } from "../../errors.js";
import { copyKey, COPY_LIMIT_REASON, COPY_MISSING_REASON, isCopyKey, MODULE_COPY_BYTES, type CopyKey } from "../../protocol/userspace-module-files.js";
import type { Pin } from "../../../wasm/handle.js";
import { ADAPTER_FILE, IntegrityError, verifyPinned } from "../../../wasm/runner/pinned.js";

/**
 * The VM's verified copies of module files (engine ADR 0028, "Integrity: once per VM"). The Userspace worker owns them,
 * and their 512 MiB budget, for as long as the VM runs. A copy is keyed by its pin (`sha256:bytes`) and kept while a
 * holder needs it: each module-command registration, and one VM-lifetime holder for `spawnModule`. The page supplies only
 * the files the VM does not hold (`missing`); the store checks size and sha256 before any of the module's code runs, and
 * concurrent holds of one file wait for one check. Compiling stays in the module frame's broker, because compiled
 * modules never cross the frame boundary.
 */

/** Who keeps copies: one registration of module commands, or `spawnModule`'s holder, which lasts until the VM goes. */
export type CopyHolder = { readonly kind: "registration"; readonly id: number } | { readonly kind: "spawn" };
/** One file a start needs: the name every failure carries in `detail.file`, and its pin. */
export interface CopyRequest { readonly file: string; readonly pin: Pin }

interface Entry {
  readonly bytes: number;
  /** Settles once with the checked copy; every holder of the key waits for this one check. */
  readonly verified: Promise<Blob>;
  readonly holders: Set<string>;
}

function never(): never { throw new VMError("PROTOCOL_ERROR", "Invalid module file pin"); }

const holderName = (holder: CopyHolder): string => holder.kind === "spawn" ? "spawn" : `registration:${String(holder.id)}`;
/** Read through a call, because the signal changes while a hold awaits its checks. */
const aborted = (signal: AbortSignal): boolean => signal.aborted;
const cancellation = (): VMError => new VMError("ABORTED", "Preparing the module's files was cancelled");

export class ModuleCopies {
  readonly #entries = new Map<CopyKey, Entry>();
  /** Checks run one after another, so at most one file's bytes are read at a time. */
  #checks: Promise<unknown> = Promise.resolve();

  /** The bytes the store holds or is checking: what counts against the budget. */
  get bytes(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.bytes;
    return total;
  }

  /** The keys of `pins` the store neither holds nor is checking, each once: what the page must supply. */
  missing(pins: readonly Pin[]): CopyKey[] {
    return [...new Set(pins.map(copyKey))].filter(key => !this.#entries.has(key));
  }

  /** Refuses, before anything is read or fetched, files whose pins would exceed the budget (`wasm-module-copy-limit`). */
  assertFits(files: readonly CopyRequest[]): void {
    const extra = [...new Map(files.map(request => [copyKey(request.pin), request.pin.bytes]))].reduce((total, [key, bytes]) => this.#entries.has(key) ? total : total + bytes, 0);
    if (this.bytes + extra > MODULE_COPY_BYTES) {
      throw new VMError("QUOTA_EXCEEDED", `A VM holds at most ${String(MODULE_COPY_BYTES / 1024 ** 2)} MiB of module files`, { reason: COPY_LIMIT_REASON });
    }
  }

  /**
   * Holds every requested copy for `holder` and answers them by key. A file the store lacks must be in `supplied`, which holds
   * only requested files; the budget is counted from the pins before any supplied byte is read. Every failure leaves the
   * holder holding nothing it did not hold before: `wasm-module-copy-missing`, `QUOTA_EXCEEDED wasm-module-copy-limit`,
   * `GUEST_CRASH wasm-module-integrity` naming the file, or ABORTED.
   */
  async hold(holder: CopyHolder, files: readonly CopyRequest[], supplied: ReadonlyMap<string, Blob>, signal: AbortSignal): Promise<ReadonlyMap<CopyKey, Blob>> {
    if (aborted(signal)) throw cancellation();
    const requested = new Map<CopyKey, CopyRequest>();
    for (const request of files) if (!requested.has(copyKey(request.pin))) requested.set(copyKey(request.pin), request);
    const absent = [...requested].filter(([key]) => !this.#entries.has(key));
    for (const key of supplied.keys()) {
      // A file another start supplied meanwhile is already being checked; its second copy is ignored.
      if (!isCopyKey(key) || !requested.has(key)) throw new VMError("PROTOCOL_ERROR", "A supplied module file was not asked for", { reason: COPY_MISSING_REASON });
    }
    const lacking = absent.find(([key]) => !supplied.has(key));
    if (lacking !== undefined) throw new VMError("PROTOCOL_ERROR", `${lacking[1].file} is neither held by the VM nor supplied`, { reason: COPY_MISSING_REASON, file: lacking[1].file });
    this.assertFits(absent.map(([, request]) => request));
    for (const [key, request] of absent) this.#check(key, request, supplied.get(key) ?? never());
    // Each check is taken now: a failed one removes its entry while this hold still waits for an earlier file.
    const name = holderName(holder), added: CopyKey[] = [], checks: (readonly [CopyKey, Promise<Blob>])[] = [];
    for (const key of requested.keys()) {
      const entry = this.#entries.get(key) ?? never();
      if (!entry.holders.has(name)) { entry.holders.add(name); added.push(key); }
      checks.push([key, entry.verified]);
    }
    const stopped = Promise.withResolvers<never>(), stop = () => { stopped.reject(cancellation()); };
    stopped.promise.catch(() => undefined);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const copies = new Map<CopyKey, Blob>();
      for (const [key, verified] of checks) copies.set(key, await Promise.race([verified, stopped.promise]));
      if (aborted(signal)) throw cancellation();
      return copies;
    } catch (error: unknown) {
      for (const key of added) this.#entries.get(key)?.holders.delete(name);
      this.#sweep();
      throw error;
    } finally { signal.removeEventListener("abort", stop); }
  }

  /** `holder` keeps nothing any more; copies no one holds are dropped. Runs that already started keep their Blobs. */
  release(holder: CopyHolder): void {
    if (holder.kind === "spawn") return;
    const name = holderName(holder);
    for (const entry of this.#entries.values()) entry.holders.delete(name);
    this.#sweep();
  }

  /** The VM is going away: every copy, including the spawn holder's, is dropped. */
  dispose(): void { this.#entries.clear(); }

  #check(key: CopyKey, request: CopyRequest, blob: Blob): void {
    const verified = this.#checks.then(async () => {
      const label = request.file === ADAPTER_FILE ? "The adapter bundle" : `Artifact ${request.file}`;
      // A size that differs from the pin is refused without reading the bytes.
      if (blob.size !== request.pin.bytes) throw new IntegrityError(`${label} is ${blob.size > request.pin.bytes ? "larger" : "shorter"} than its pin`, request.file);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await verifyPinned(bytes, request.pin, label, request.file);
      return new Blob([bytes]);
    });
    this.#checks = verified.catch(() => undefined);
    const entry: Entry = { bytes: request.pin.bytes, verified, holders: new Set() };
    // A failed check keeps nothing: its holders fail, and the key counts as missing again.
    verified.catch(() => { if (this.#entries.get(key) === entry) this.#entries.delete(key); });
    this.#entries.set(key, entry);
  }

  #sweep(): void {
    for (const [key, entry] of this.#entries) if (entry.holders.size === 0) this.#entries.delete(key);
  }
}
