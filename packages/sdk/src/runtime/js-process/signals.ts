import { operation, protocol, Writer, type LinuxOperation, type LinuxResult } from "./codec.ts";
import { integer } from "../decode.ts";
import type { RealtimeSignalNumber } from "../process-signals.ts";
export type { RealtimeSignalNumber } from "../process-signals.ts";

/** The first and last real-time signals of a JS process: musl reserves 32 to 34 for itself. */
export const SIGRTMIN = 35;
export const SIGRTMAX = 64;

/** The standard signals a JS process can catch: SIGHUP, SIGINT, SIGQUIT, SIGUSR1, SIGUSR2 and SIGTERM. */
export const STANDARD_TRAPPABLE_SIGNALS = [1, 2, 3, 10, 12, 15] as const;
export type StandardSignalNumber = (typeof STANDARD_TRAPPABLE_SIGNALS)[number];
export type TrappableSignalNumber = StandardSignalNumber | RealtimeSignalNumber;

export function isRealtimeSignal(value: unknown): value is RealtimeSignalNumber {
  return typeof value === "number" && Number.isInteger(value) && value >= SIGRTMIN && value <= SIGRTMAX;
}
export function isTrappableSignal(value: unknown): value is TrappableSignalNumber {
  return STANDARD_TRAPPABLE_SIGNALS.some(signal => signal === value) || isRealtimeSignal(value);
}

/**
 * The signals a JS process can catch (engine ADR 0027, amended for real-time signals): the closed set Rust's signal owner
 * accepts for host dispositions, notices (OXCS) and signal exits (command operation 7), lowest first.
 */
export const TRAPPABLE_SIGNALS: readonly TrappableSignalNumber[] = [
  ...STANDARD_TRAPPABLE_SIGNALS,
  ...Array.from({ length: SIGRTMAX - SIGRTMIN + 1 }, (_, index) => SIGRTMIN + index).filter(isRealtimeSignal),
];

/** What a real-time arrival carried: si_code, si_pid, si_uid and si_value, as Rust's OXCS 2 notice reported them. */
export interface SignalDetails { readonly code: number; readonly sender: number; readonly uid: number; readonly value: bigint }
/** One signal handed to a process: a standard signal, or a real-time one with its details unless the ring was full. */
export interface SignalArrival { readonly signal: TrappableSignalNumber; readonly details: SignalDetails | null }

/**
 * The `signals` SharedArrayBuffer of every non-native start message (JS process protocol 5), 1,568 bytes:
 * - bytes 0-7: two Int32 words of pending bits, bit n-1 of word 0 for signal n up to 32, bit n-33 of word 1 above it;
 *   the driver sets bits and the worker takes them;
 * - bytes 8-11: the interrupt word in Pyodide's interrupt-buffer format; the driver stores a signal there only while
 *   it reads 0, and the module resets it once it has acted on it;
 * - bytes 12-15 and 16-19: the ring's write count (the driver's) and read count (the worker's), both wrapping;
 * - bytes 20-31: zero;
 * - bytes 32-1567: 64 slots of 24 bytes, each a real-time arrival with its details: i32 signal, i32 si_code,
 *   u32 si_pid, u32 si_uid, u64 si_value, little-endian. A full ring sets the pending bit instead, without details.
 */
export const SIGNAL_RING_SLOTS = 64;
const RING_OFFSET = 32, SLOT_BYTES = 24;
export const SIGNAL_BUFFER_BYTES = RING_OFFSET + SIGNAL_RING_SLOTS * SLOT_BYTES;
const INTERRUPT_WORD = 2, WRITTEN = 3, READ = 4;

/** A validated signal buffer: its Int32 words and a byte view of its slots. */
export interface SignalBuffer { readonly buffer: SharedArrayBuffer; readonly words: Int32Array<SharedArrayBuffer>; readonly view: DataView<SharedArrayBuffer> }

/** The signal buffer of a start message, refusing anything else. */
export function signalBuffer(buffer: unknown): SignalBuffer {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== SIGNAL_BUFFER_BYTES) protocol("Invalid JS process signal buffer");
  return { buffer, words: new Int32Array(buffer, 0, RING_OFFSET / 4), view: new DataView(buffer) };
}

/** The interrupt word alone, the view the runner hands a module as Pyodide's interrupt buffer. */
export function interruptView(buffer: SharedArrayBuffer): Int32Array<SharedArrayBuffer> {
  return new Int32Array(buffer, INTERRUPT_WORD * 4, 1);
}

const word = (signal: TrappableSignalNumber): number => signal <= 32 ? 0 : 1;
const bit = (signal: TrappableSignalNumber): number => 1 << ((signal - 1) % 32);
const TRAPPABLE_BITS = [0, 1].map(index => TRAPPABLE_SIGNALS.filter(signal => word(signal) === index).reduce((bits, signal) => bits | bit(signal), 0));

/** Driver: hands `arrival` to the process; a real-time arrival with details takes a slot while one is free. */
export function deliverArrival(target: SignalBuffer, arrival: SignalArrival): void {
  const { signal, details } = arrival;
  if (!isTrappableSignal(signal)) protocol("Untrappable JS process signal");
  const written = Atomics.load(target.words, WRITTEN);
  if (isRealtimeSignal(signal) && details !== null && (written - Atomics.load(target.words, READ)) >>> 0 < SIGNAL_RING_SLOTS) {
    const offset = RING_OFFSET + (written >>> 0) % SIGNAL_RING_SLOTS * SLOT_BYTES;
    target.view.setInt32(offset, signal, true); target.view.setInt32(offset + 4, details.code, true);
    target.view.setUint32(offset + 8, details.sender, true); target.view.setUint32(offset + 12, details.uid, true);
    target.view.setBigUint64(offset + 16, details.value, true);
    Atomics.store(target.words, WRITTEN, (written + 1) | 0);
  } else Atomics.or(target.words, word(signal), bit(signal));
  Atomics.notify(target.words, 0);
}

/** Driver: stores `signal` in the interrupt word unless the module has not taken the previous one yet. */
export function offerInterrupt(target: SignalBuffer, signal: TrappableSignalNumber): boolean {
  if (Atomics.compareExchange(target.words, INTERRUPT_WORD, 0, signal) !== 0) return false;
  Atomics.notify(target.words, INTERRUPT_WORD); return true;
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

/** OXJR 14's `how`, on Linux's numbers: SIG_BLOCK 0, SIG_UNBLOCK 1, SIG_SETMASK 2. */
export type MaskHow = "block" | "unblock" | "set";
const HOWS: readonly MaskHow[] = ["block", "unblock", "set"];
/** A signal set, bit n-1 for signal n, as rt_sigprocmask and rt_sigpending read and write it. */
export function signalSet(numbers: Iterable<number>): bigint {
  let set = 0n;
  for (const number of numbers) set |= 1n << BigInt(integer(number, "signal number", 1, 64) - 1);
  return set;
}
/** The signal numbers in `set`, lowest first. */
export function signalsOf(set: bigint): number[] {
  return Array.from({ length: 64 }, (_, index) => index + 1).filter(number => (set >> BigInt(number - 1) & 1n) === 1n);
}
function maskValue(result: LinuxResult): bigint {
  if (result.bytes.byteLength !== 0 || result.value < 0n || result.value > 0xffff_ffff_ffff_ffffn) protocol("Invalid signal mask result");
  return result.value;
}
/** OXJR 14, rt_sigprocmask(how, &set, &old) for the process's task: `{u8 how, u64 set}`, answered with the previous mask. */
export function maskOperation(how: MaskHow, set: bigint): LinuxOperation<bigint> {
  return operation(14, new Writer().u8(HOWS.indexOf(how)).u64(set), maskValue);
}
/** OXJR 127, rt_sigpending: no fields, answered with the pending signals the task blocks. */
export function pendingOperation(): LinuxOperation<bigint> {
  return operation(127, new Writer(), maskValue);
}

/**
 * Worker: takes every arrival exactly once: pending standard signals lowest first, then the ring's real-time arrivals
 * in the order they arrived, then real-time signals that arrived while the ring was full, lowest first.
 */
export function takeArrivals(source: SignalBuffer): SignalArrival[] {
  const read = Atomics.load(source.words, READ), written = Atomics.load(source.words, WRITTEN), count = (written - read) >>> 0;
  if (count > SIGNAL_RING_SLOTS) protocol("Invalid JS process signal ring");
  const queued: SignalArrival[] = [];
  for (let index = 0; index < count; index++) {
    const offset = RING_OFFSET + ((read + index) >>> 0) % SIGNAL_RING_SLOTS * SLOT_BYTES, signal = source.view.getInt32(offset, true);
    if (!isRealtimeSignal(signal)) protocol("Invalid JS process signal ring");
    queued.push({ signal, details: { code: source.view.getInt32(offset + 4, true), sender: source.view.getUint32(offset + 8, true), uid: source.view.getUint32(offset + 12, true), value: source.view.getBigUint64(offset + 16, true) } });
  }
  Atomics.store(source.words, READ, written);
  const bits = [Atomics.exchange(source.words, 0, 0), Atomics.exchange(source.words, 1, 0)];
  if (bits.some((value, index) => (value & ~(TRAPPABLE_BITS[index] ?? 0)) !== 0)) protocol("Invalid pending JS process signals");
  const pending = TRAPPABLE_SIGNALS.filter(signal => ((bits[word(signal)] ?? 0) & bit(signal)) !== 0);
  return [
    ...pending.filter(signal => !isRealtimeSignal(signal)).map(signal => ({ signal, details: null })),
    ...queued,
    ...pending.filter(isRealtimeSignal).map(signal => ({ signal, details: null })),
  ];
}
