import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";
import { validateAssistanceCredit, type AssistanceCredit } from "../../protocol/assistance-credit.js";

import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";

export const PROCESS_MESSAGE_BYTES = 512 * 1024;
// Shared mailbox and process encoder/message partition; the verified runtime
// transfer is additional startup storage, released on the ready receipt.
export const PROCESS_TRANSPORT_BYTES = [ASSISTANCE_LIMITS.request + 16,
  PROCESS_MESSAGE_BYTES + ASSISTANCE_LIMITS.request] as const;
export function brokerDataCredit(runtimeBytes: number): number {
  return Math.max(15 * ASSISTANCE_LIMITS.stream / 8,
    runtimeBytes + PROCESS_TRANSPORT_BYTES.reduce((sum, bytes) => sum + bytes, 0));
}

type Pool = "data" | "control";

/** A producer spends an already-issued window. It cannot enlarge the VM budget
 * or return it while any local transport allocation remains owned. */
export class GrantedTraffic {
  readonly #grants: readonly AssistanceCredit[];
  readonly #available = { data: { bytes: 0, entries: 0 }, control: { bytes: 0, entries: 0 } };
  readonly #pending = new Map<number, { readonly pool: Pool; readonly bytes: number }>();
  readonly #waiting = new Map<number, { readonly bytes: number; readonly finish: (error?: VMError) => void }>();
  #sequence = 0;
  #retired = false;

  constructor(binding: Pick<AssistanceCredit, "session" | "generation" | "producer" | "process">, values: unknown, version: 5 | 6 = 5) {
    if (!Array.isArray(values) || values.length !== 2) throw new VMError("PROTOCOL_ERROR", "Missing producer grants");
    const grants = values.map((value: unknown) => validateAssistanceCredit(value, version));
    const seen = new Set<Pool>();
    const reservations = new Set<number>(); const sequences = new Set<number>();
    for (const grant of grants) {
      if (grant.kind !== "grant" || grant.producer !== binding.producer || grant.session !== binding.session
        || grant.generation !== binding.generation || grant.process !== binding.process
        || seen.has(grant.pool) || reservations.has(grant.reservation) || sequences.has(grant.sequence)) {
        throw new VMError("PROTOCOL_ERROR", "Invalid producer grant identity");
      }
      seen.add(grant.pool); reservations.add(grant.reservation); sequences.add(grant.sequence);
      this.#available[grant.pool] = { bytes: grant.bytes, entries: grant.entries };
    }
    this.#grants = grants;
  }

  reserve(pool: Pool, bytes: number): number {
    if (this.#retired) throw new VMError("ABORTED", "Producer grants are retired");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new VMError("PROTOCOL_ERROR", "Invalid producer reservation");
    const available = this.#available[pool];
    if (bytes > available.bytes || available.entries === 0 || this.#sequence === 0xffff_ffff) {
      throw new VMError("QUOTA_EXCEEDED",
        `Producer credit capacity exhausted: requested ${bytes} ${pool} bytes; available ${available.bytes} bytes/${available.entries} entries; sequence ${this.#sequence}`,
        { pool, requestedBytes: bytes, availableBytes: available.bytes, availableEntries: available.entries,
          sequence: this.#sequence, producer: this.#grants[0]?.producer });
    }
    const reservation = ++this.#sequence;
    available.bytes -= bytes; available.entries -= 1;
    this.#pending.set(reservation, { pool, bytes });
    return reservation;
  }

  /** Separate retained working bytes from a reply acquired atomically with them. */
  split(reservation: number, bytes: number): number {
    const pending = this.#pending.get(reservation);
    if (pending === undefined || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= pending.bytes) {
      throw new VMError("PROTOCOL_ERROR", "Invalid producer reservation split");
    }
    const available = this.#available[pending.pool];
    if (available.entries === 0 || this.#sequence === 0xffff_ffff) {
      throw new VMError("QUOTA_EXCEEDED", "Producer credit capacity exhausted");
    }
    const identity = ++this.#sequence;
    available.entries -= 1;
    this.#pending.set(reservation, { pool: pending.pool, bytes: pending.bytes - bytes });
    this.#pending.set(identity, { pool: pending.pool, bytes });
    return identity;
  }

  release(reservation: number): void {
    this.#remove(reservation);
    this.#drain();
  }

  /** Wait for data capacity without borrowing from another producer's grant. */
  async acquire(bytes: number, signal: AbortSignal): Promise<number> {
    if (this.#retired || signal.aborted) throw new VMError("ABORTED", "Producer acquisition cancelled");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new VMError("PROTOCOL_ERROR", "Invalid producer reservation");
    const grant = this.#grants.find(credit => credit.pool === "data");
    if (grant === undefined || bytes > grant.bytes || this.#sequence === 0xffff_ffff) {
      throw new VMError("QUOTA_EXCEEDED", "Producer credit capacity exhausted");
    }
    if (this.#waiting.size === 0 && this.#fits(bytes)) return this.reserve("data", bytes);
    if (this.#waiting.size >= 128) throw new VMError("QUOTA_EXCEEDED", "Producer acquisition queue exhausted");
    const entry = this.reserve("control", 128);
    return new Promise<number>((resolve, reject) => {
      const abort = (): void => { finish(new VMError("ABORTED", "Producer acquisition cancelled")); this.#drain(); };
      const finish = (error?: VMError): void => {
        this.#waiting.delete(entry);
        signal.removeEventListener("abort", abort);
        this.#remove(entry);
        if (error !== undefined) { reject(error); return; }
        try { resolve(this.reserve("data", bytes)); } catch (failure) { reject(deserializeError(serializeUnknownError(failure))); }
      };
      this.#waiting.set(entry, { bytes, finish });
      signal.addEventListener("abort", abort, { once: true });
      this.#drain();
    });
  }

  #fits(bytes: number): boolean {
    return bytes <= this.#available.data.bytes && this.#available.data.entries > 0;
  }

  #drain(): void {
    for (const waiter of this.#waiting.values()) {
      // A larger opening must not block a smaller read that can retire an
      // existing stream and release the capacity needed by that opening.
      if (!this.#fits(waiter.bytes)) continue;
      waiter.finish();
    }
  }

  #remove(reservation: number): void {
    const pending = this.#pending.get(reservation);
    if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown producer reservation");
    this.#pending.delete(reservation);
    this.#available[pending.pool].bytes += pending.bytes;
    this.#available[pending.pool].entries += 1;
  }

  returns(): readonly AssistanceCredit[] {
    if (this.#retired) throw new VMError("PROTOCOL_ERROR", "Producer grants are retired");
    if (this.#pending.size !== 0) throw new VMError("PROTOCOL_ERROR", "Producer buffers are still pending");
    this.#retired = true;
    return this.#grants.map(grant => ({ ...grant, kind: "return" }));
  }
}
