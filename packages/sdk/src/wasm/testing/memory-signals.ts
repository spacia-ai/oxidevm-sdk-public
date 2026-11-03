import { LinuxError } from "../../runtime/js-process/codec.js";
import { interruptView, isTrappableSignal, SIGNAL_BUFFER_BYTES, type MaskHow, type SignalArrival, type SignalDisposition, type TrappableSignalNumber } from "../../runtime/js-process/signals.js";
import type { SignalTransport } from "../runner/signals.js";

/**
 * A process's signals with the test playing Rust: each disposition is recorded and answered with the previous one (an
 * `ignored` signal starts as "ignore"; a `refuse`d one fails with EOPNOTSUPP), `deliver` hands signals to the listener,
 * `release` answers the oldest held disposition when `deferred`, and `exits` lists the signals the process ended by.
 */
export function fakeSignals(options: { readonly ignored?: readonly TrappableSignalNumber[]; readonly refuse?: readonly TrappableSignalNumber[]; readonly deferred?: boolean } = {}) {
  const dispositions = new Map<TrappableSignalNumber, SignalDisposition>((options.ignored ?? []).map(signal => [signal, "ignore"]));
  const calls: [TrappableSignalNumber, SignalDisposition][] = [], exits: TrappableSignalNumber[] = [], refused = new Set(options.refuse ?? []), held: (() => void)[] = [];
  const listening: { listener?: (arrivals: readonly SignalArrival[]) => void; count: number } = { count: 0 };
  const masks: [MaskHow, bigint][] = [], kills: TrappableSignalNumber[] = [], state = { blocked: 0n, pending: 0n };
  /** Rust's delivery to this process: blocked signals wait, caught ones reach the listener, ignored ones vanish, others end it. */
  const arrive = (signal: TrappableSignalNumber): void => {
    const bit = 1n << BigInt(signal - 1);
    if ((state.blocked & bit) !== 0n) { state.pending |= bit; return; }
    const disposition = dispositions.get(signal) ?? "default";
    if (disposition === "caught") listening.listener?.([{ signal, details: signal < 32 ? null : { code: 0, sender: 7, uid: 1000, value: 0n } }]);
    else if (disposition === "default") exits.push(signal);
  };
  const transport: SignalTransport = {
    setDisposition: async (signal, disposition) => {
      calls.push([signal, disposition]);
      if (options.deferred === true) await new Promise<void>(resolve => { held.push(resolve); });
      if (refused.has(signal)) throw new LinuxError(95);
      const previous = dispositions.get(signal) ?? "default";
      dispositions.set(signal, disposition);
      return previous;
    },
    listen: listener => { listening.listener = listener; listening.count += 1; },
    interruptWord: interruptView(new SharedArrayBuffer(SIGNAL_BUFFER_BYTES)),
    mask: (how, set) => {
      masks.push([how, set]);
      const previous = state.blocked;
      state.blocked = how === "block" ? previous | set : how === "unblock" ? previous & ~set : set;
      const released = state.pending & ~state.blocked; state.pending &= state.blocked;
      for (let signal = 1; signal <= 64; signal++) if ((released >> BigInt(signal - 1) & 1n) === 1n && isTrappableSignal(signal)) arrive(signal);
      return Promise.resolve(previous);
    },
    pending: () => Promise.resolve(state.pending),
    kill: signal => {
      kills.push(signal);
      // A default action ends the process: Rust reports the exit and the call never answers.
      const ends = (state.blocked & 1n << BigInt(signal - 1)) === 0n && (dispositions.get(signal) ?? "default") === "default";
      arrive(signal);
      return ends ? new Promise<never>(() => undefined) : Promise.resolve();
    },
  };
  return {
    ...transport, calls, exits, dispositions, refused, masks, kills,
    get listeners() { return listening.count; },
    /** Hands signals over as arrivals without details; `arrive` hands over arrivals as they are. */
    deliver: (signals: readonly TrappableSignalNumber[]) => { listening.listener?.(signals.map(signal => ({ signal, details: null }))); },
    arrive: (arrivals: readonly SignalArrival[]) => { listening.listener?.(arrivals); },
    release: () => { held.shift()?.(); },
  };
}
