import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";
import { ASSISTANCE_LIMITS, type AssistanceBinding } from "../../protocol/assistance.js";
import { validateAssistanceCredit, type AssistanceCredit } from "../../protocol/assistance-credit.js";

type TrafficKind = "data" | "control";
type Reservation =
  | { readonly owner: "local"; readonly process: number | null; readonly pool: TrafficKind; readonly bytes: number; readonly entries: number }
  | { readonly owner: "grant"; readonly credit: AssistanceCredit };
type CreditOffer =
  | Omit<Extract<AssistanceCredit, { process: null }>, "sequence" | "reservation" | "kind">
  | Omit<Extract<AssistanceCredit, { process: number }>, "sequence" | "reservation" | "kind">;

/** Private accounting for SystemAssistance, the VM's single budget authority.
 * Reservations remain owned until acknowledgement or explicit retirement. */
export class AssistanceTraffic {
  readonly #version: 5 | 6 | 7;
  constructor(version: 5 | 6 | 7 = 5) { this.#version = version; }

  readonly #reservations = new Map<number, Reservation>();
  readonly #bytes = { data: 0, control: 0 };
  readonly #entries = { data: 0, control: 0 };
  #sequence = 0;
  #grantSequence = 0;
  readonly #waiting = new Map<number, { readonly bytes: number; readonly finish: (error?: VMError) => void }>();

  get pendingBytes(): number { return this.#bytes.data + this.#bytes.control; }

  get pendingEntries(): number { return this.#entries.data + this.#entries.control; }

  /** null denotes this VM's installation/network work, never a process alias. */
  reserve(process: number | null, kind: TrafficKind, bytes: number): number {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || (process !== null && (!Number.isInteger(process) || process < 1 || process > 0xffff_ffff))) {
      throw new VMError("PROTOCOL_ERROR", "Invalid assistance reservation");
    }
    return this.#allocate({ owner: "local", process, pool: kind, bytes, entries: 1 });
  }

  async acquire(process: number | null, bytes: number, signal: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || (process !== null && (!Number.isInteger(process) || process < 1 || process > 0xffff_ffff))) {
      throw new VMError("PROTOCOL_ERROR", "Invalid assistance reservation");
    }
    if (signal.aborted) throw new VMError("ABORTED", "Assistance dispatch cancelled");
    if (bytes > ASSISTANCE_LIMITS.pending - ASSISTANCE_LIMITS.stream || this.#sequence === 0xffff_ffff) {
      throw new VMError("QUOTA_EXCEEDED", "Assistance reservation capacity exhausted");
    }
    if (this.#waiting.size === 0 && this.#fits("data", bytes, 1)) return this.reserve(process, "data", bytes);
    if (this.#waiting.size >= 128) throw new VMError("QUOTA_EXCEEDED", "Assistance dispatch queue exhausted");
    const entry = this.reserve(process, "control", 128);
    return new Promise<number>((resolve, reject) => {
      const abort = (): void => { finish(new VMError("ABORTED", "Assistance dispatch cancelled")); this.#drain(); };
      const finish = (error?: VMError): void => {
        this.#waiting.delete(entry);
        signal.removeEventListener("abort", abort);
        const reservation = this.#reservations.get(entry);
        if (reservation !== undefined) this.#remove(entry, reservation);
        if (error !== undefined) { reject(error); return; }
        try { resolve(this.reserve(process, "data", bytes)); } catch (failure) { reject(deserializeError(serializeUnknownError(failure))); }
      };
      this.#waiting.set(entry, { bytes, finish });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #drain(): void {
    for (const waiter of this.#waiting.values()) {
      if (!this.#fits("data", waiter.bytes, 1)) break;
      waiter.finish();
    }
  }

  grant(offer: CreditOffer): AssistanceCredit {
    if (this.#sequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Assistance reservation sequence exhausted");
    if (this.#grantSequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Assistance credit sequence exhausted");
    const credit = Object.freeze(validateAssistanceCredit({ ...offer, kind: "grant",
      sequence: this.#grantSequence + 1, reservation: this.#sequence + 1 }, this.#version));
    this.#allocate({ owner: "grant", credit });
    this.#grantSequence += 1;
    return credit;
  }

  returnCredit(value: unknown): void {
    const credit = validateAssistanceCredit(value, this.#version);
    const reservation = this.#reservations.get(credit.reservation);
    if (credit.kind !== "return" || reservation?.owner !== "grant") this.#stale();
    const grant = reservation.credit;
    if (credit.session !== grant.session || credit.generation !== grant.generation ||
      credit.process !== grant.process || credit.producer !== grant.producer || credit.sequence !== grant.sequence ||
      credit.pool !== grant.pool || credit.bytes !== grant.bytes || credit.entries !== grant.entries) this.#stale();
    this.#remove(credit.reservation, reservation);
    this.#drain();
  }

  /** Only after the bound producer has stopped and its queued buffers are released. */
  retireGrants(binding: AssistanceBinding, process: number | null, producer: AssistanceCredit["producer"]): void {
    for (const [id, reservation] of this.#reservations) {
      if (reservation.owner !== "grant") continue;
      const credit = reservation.credit;
      if (credit.session === binding.session && credit.generation === binding.generation && credit.process === process && credit.producer === producer) {
        this.#remove(id, reservation);
      }
    }
    this.#drain();
  }

  #fits(pool: TrafficKind, bytes: number, entries: number): boolean {
    const limit = pool === "control" ? ASSISTANCE_LIMITS.stream : ASSISTANCE_LIMITS.pending - ASSISTANCE_LIMITS.stream;
    return bytes <= limit - this.#bytes[pool] && entries <= (pool === "control" ? 1024 : 4096) - this.#entries[pool];
  }

  #allocate(reservation: Reservation): number {
    const { pool, bytes, entries } = reservation.owner === "grant" ? reservation.credit : reservation;
    if (!this.#fits(pool, bytes, entries)) {
      const producer = reservation.owner === "grant" ? reservation.credit.producer : "local";
      throw new VMError("QUOTA_EXCEEDED",
        `Assistance traffic capacity exhausted: ${producer} requested ${bytes} ${pool} bytes/${entries} entries; holding ${this.#bytes[pool]} bytes/${this.#entries[pool]} entries`,
        { pool, producer, requestedBytes: bytes, requestedEntries: entries,
          pendingBytes: this.#bytes[pool], pendingEntries: this.#entries[pool] });
    }
    if (this.#sequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Assistance reservation sequence exhausted");
    const id = ++this.#sequence;
    this.#reservations.set(id, reservation);
    this.#bytes[pool] += bytes;
    this.#entries[pool] += entries;
    return id;
  }

  release(process: number | null, id: number): void {
    const reservation = this.#reservations.get(id);
    if (reservation?.owner !== "local" || reservation.process !== process) this.#stale();
    this.#remove(id, reservation);
    this.#drain();
  }

  #remove(id: number, reservation: Reservation): void {
    const { pool, bytes, entries } = reservation.owner === "grant" ? reservation.credit : reservation;
    this.#reservations.delete(id);
    this.#bytes[pool] -= bytes;
    this.#entries[pool] -= entries;
  }

  #stale(): never { throw new VMError("PROTOCOL_ERROR", "Unknown or stale assistance reservation"); }
}
