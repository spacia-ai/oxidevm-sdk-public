import type { CommandSignalNotice } from "../../userspace-command-abi.js";
import { markSignalPending, offerInterrupt, signalWords, SIGNAL_WORDS_BYTES, TRAPPABLE_SIGNALS, type TrappableSignalNumber } from "../../js-process/signals.js";

/**
 * The driver's side of one non-native JS process's signal words (engine ADR 0027): each notice Rust took for the
 * process sets its pending bit, and an interrupting one waits for the interrupt word until the module has taken the
 * previous signal from it.
 */
export class TaskSignals {
  readonly buffer = new SharedArrayBuffer(SIGNAL_WORDS_BYTES);
  readonly #words = signalWords(this.buffer);
  readonly #interrupts = new Set<TrappableSignalNumber>();

  deliver(notice: CommandSignalNotice): void {
    markSignalPending(this.#words, notice.signal);
    if (notice.interrupt) this.#interrupts.add(notice.signal);
    this.offerInterrupts();
  }

  /** Stores the lowest waiting interrupt while the interrupt word reads 0; later reconciles retry the rest. */
  offerInterrupts(): void {
    for (const signal of TRAPPABLE_SIGNALS) {
      if (!this.#interrupts.has(signal)) continue;
      if (!offerInterrupt(this.#words, signal)) return;
      this.#interrupts.delete(signal);
    }
  }
}
