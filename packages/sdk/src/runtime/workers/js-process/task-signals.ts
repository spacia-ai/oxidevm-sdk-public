import { deliverArrival, offerInterrupt, signalBuffer, SIGNAL_BUFFER_BYTES, TRAPPABLE_SIGNALS, type SignalDetails, type TrappableSignalNumber } from "../../js-process/signals.js";

/** A notice Rust took for a process (OXCS 2): the signal, whether it interrupts, and the details it arrived with. */
export interface SignalNoticeArrival { readonly signal: TrappableSignalNumber; readonly interrupt: boolean; readonly details: SignalDetails }

/**
 * The driver's side of one non-native JS process's signal buffer (JS process protocol 5, engine ADR 0027): each notice
 * Rust took for the process becomes an arrival, a real-time one with its details, and an interrupting one waits for the
 * interrupt word until the module has taken the previous signal from it.
 */
export class TaskSignals {
  readonly buffer = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES);
  readonly #target = signalBuffer(this.buffer);
  readonly #interrupts = new Set<TrappableSignalNumber>();

  deliver(notice: SignalNoticeArrival): void {
    // A standard signal carries no details to the process: it is pending once, as in Linux.
    deliverArrival(this.#target, { signal: notice.signal, details: notice.signal < 32 ? null : notice.details });
    if (notice.interrupt) this.#interrupts.add(notice.signal);
    this.offerInterrupts();
  }

  /** Whether an interrupting signal still waits for the module to take the previous one. */
  get waiting(): boolean { return this.#interrupts.size > 0; }

  /** Stores the lowest waiting interrupt while the interrupt word reads 0; later reconciles retry the rest. */
  offerInterrupts(): void {
    for (const signal of TRAPPABLE_SIGNALS) {
      if (!this.#interrupts.has(signal)) continue;
      if (!offerInterrupt(this.#target, signal)) return;
      this.#interrupts.delete(signal);
    }
  }
}
