import { operation, protocol, Writer, type LinuxOperation } from "./codec.ts";

/**
 * The signals a JS process can catch (engine ADR 0027): SIGHUP, SIGINT, SIGQUIT, SIGUSR1, SIGUSR2 and SIGTERM, the
 * closed set Rust's signal owner accepts for host dispositions, notices (OXCS) and signal exits (command operation 7).
 */
export const TRAPPABLE_SIGNALS = [1, 2, 3, 10, 12, 15] as const;
export type TrappableSignalNumber = (typeof TRAPPABLE_SIGNALS)[number];

export function isTrappableSignal(value: unknown): value is TrappableSignalNumber {
  return TRAPPABLE_SIGNALS.some(signal => signal === value);
}

const bit = (signal: TrappableSignalNumber): number => 1 << (signal - 1);
const TRAPPABLE_BITS = TRAPPABLE_SIGNALS.reduce((bits, signal) => bits | bit(signal), 0);

/**
 * The `signals` SharedArrayBuffer of every non-native start message (JS process protocol 4): two Int32 words. Word 0
 * holds the pending signals, bit n-1 for signal n: the driver sets bits, the worker takes them. Word 1 is the
 * interrupt word in Pyodide's interrupt-buffer format: the driver stores a signal there only while it reads 0, and the
 * module resets it once it has acted on it.
 */
export const SIGNAL_WORDS_BYTES = 8;

/** The two words of a start message's `signals`, refusing anything else. */
export function signalWords(buffer: unknown): Int32Array<SharedArrayBuffer> {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== SIGNAL_WORDS_BYTES) protocol("Invalid JS process signal words");
  return new Int32Array(buffer);
}

/** Driver: marks `signal` pending and wakes a waiter on word 0. */
export function markSignalPending(words: Int32Array<SharedArrayBuffer>, signal: TrappableSignalNumber): void {
  Atomics.or(words, 0, bit(signal)); Atomics.notify(words, 0);
}

/** Driver: stores `signal` in the interrupt word unless the module has not taken the previous one yet. */
export function offerInterrupt(words: Int32Array<SharedArrayBuffer>, signal: TrappableSignalNumber): boolean {
  if (Atomics.compareExchange(words, 1, 0, signal) !== 0) return false;
  Atomics.notify(words, 1); return true;
}

/** A trappable signal's host disposition (OXJR 65550): its default action, ignored, or caught for the process. */
export type SignalDisposition = "default" | "ignore" | "caught";
const DISPOSITIONS: readonly SignalDisposition[] = ["default", "ignore", "caught"];
/** OXJR 65550's flags: bit 0 restarts interrupted requests, bit 1 interrupts them. */
const INTERRUPT = 0b10;

/**
 * OXJR operation 65550: sets `signal`'s host disposition and answers the previous one, so an inherited SIG_IGN reads
 * "ignore". A caught signal interrupts the process's blocking requests with EINTR: the restart flag is never set.
 */
export function dispositionOperation(signal: TrappableSignalNumber, disposition: SignalDisposition): LinuxOperation<SignalDisposition> {
  return operation(65550, new Writer().u8(signal).u8(DISPOSITIONS.indexOf(disposition)).u8(disposition === "caught" ? INTERRUPT : 0), result => {
    if (result.bytes.byteLength !== 0) protocol("Invalid signal disposition result");
    return DISPOSITIONS[Number(result.value)] ?? protocol("Invalid previous signal disposition");
  });
}

/** Worker: takes every pending signal exactly once, lowest first. */
export function takePendingSignals(words: Int32Array<SharedArrayBuffer>): TrappableSignalNumber[] {
  const bits = Atomics.exchange(words, 0, 0);
  if ((bits & ~TRAPPABLE_BITS) !== 0) protocol("Invalid pending JS process signals");
  return TRAPPABLE_SIGNALS.filter(signal => (bits & bit(signal)) !== 0);
}
