import { VMError } from "../../runtime/errors.js";
import { isRealtimeSignal, isTrappableSignal, type SignalArrival, type TrappableSignalNumber } from "../../runtime/js-process/signals.js";
import { knownLinuxSignal, signalNumber } from "../../runtime/process-signals.js";
import type { RealtimeArrival, SignalTrap, TrapArrival, TrappableSignal, TrappedSignal, TrapSignal } from "../capabilities.js";

/** The most real-time arrivals one trap holds before the module takes them; Rust's own queue limit bounds the rest. */
const MAX_QUEUED = 4096;

/** How a trap lists a signal: a standard one by name, a real-time one by number. */
export type TrapEntry = TrappedSignal<TrapSignal>;
/** What a trap yields: a standard signal's name or a real-time arrival. */
export type TrapItem = TrapArrival<TrapSignal>;

function isStandardName(value: string | null): value is TrappableSignal {
  return value === "SIGHUP" || value === "SIGINT" || value === "SIGQUIT" || value === "SIGTERM" || value === "SIGUSR1" || value === "SIGUSR2";
}

/**
 * A signal a module may trap, from the adapter's untrusted argument: a standard trappable name, or a real-time signal by
 * name or by number (35 to 64). Anything else, SIGKILL and SIGSTOP included, is refused.
 */
export function trapNumber(value: unknown): TrappableSignalNumber {
  const number = typeof value === "number" && !isRealtimeSignal(value) ? null : signalNumber(value);
  if (number === null || !isTrappableSignal(number)) {
    throw new VMError("INVALID_ARGUMENT", `${String(value)} is not a signal a module can trap: SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2 or a real-time signal (SIGRTMIN to SIGRTMAX, 35 to 64)`);
  }
  return number;
}

/** The name of standard trappable signal `number`. */
function standardName(number: TrappableSignalNumber): TrappableSignal {
  const name = knownLinuxSignal(number);
  if (!isStandardName(name)) throw new VMError("PROTOCOL_ERROR", `Signal ${String(number)} is not trappable`);
  return name;
}
/** How a trap lists signal `number`. */
export function trapEntry(number: TrappableSignalNumber): TrapEntry {
  return isRealtimeSignal(number) ? number : standardName(number);
}

/** What a trap yields for `arrival`: a real-time arrival that lost its details carries Linux's SI_USER zeros. */
function trapItem({ signal, details }: SignalArrival): TrapItem {
  if (!isRealtimeSignal(signal)) return standardName(signal);
  const item: RealtimeArrival = { signal, value: details?.value ?? 0n, code: details?.code ?? 0, pid: details?.sender ?? 0, uid: details?.uid ?? 0 };
  return Object.freeze(item);
}

/** One trap: the signals it took, delivered through its iterator until it is untrapped. */
export class Trap {
  readonly interruptBuffer: Int32Array;
  readonly #release: (trap: Trap) => Promise<void>;
  readonly #queue: TrapItem[] = [];
  readonly #waiting: ((result: IteratorResult<TrapItem, undefined>) => void)[] = [];
  #signals: readonly TrapEntry[] = Object.freeze([]);
  #ended = false;

  constructor(interruptBuffer: Int32Array, release: (trap: Trap) => Promise<void>) { this.interruptBuffer = interruptBuffer; this.#release = release; }
  get signals(): readonly TrapEntry[] { return this.#signals; }
  get ended(): boolean { return this.#ended; }
  installed(signals: readonly TrappableSignalNumber[]): void { this.#signals = Object.freeze(signals.map(trapEntry)); }

  /**
   * A pending standard signal is pending once, as in Linux: a second delivery before the module takes the first adds
   * nothing. Real-time arrivals queue in order, each with its details.
   */
  deliver(arrival: SignalArrival): void {
    if (this.#ended) return;
    const item = trapItem(arrival), waiting = this.#waiting.shift();
    if (waiting !== undefined) waiting({ value: item, done: false });
    else if (typeof item !== "string" ? this.#queue.length < MAX_QUEUED : !this.#queue.includes(item)) this.#queue.push(item);
  }

  /** Drops pending signals and ends every iteration. */
  end(): void {
    this.#ended = true; this.#queue.length = 0;
    for (const waiting of this.#waiting.splice(0)) waiting({ value: undefined, done: true });
  }

  untrap(): Promise<void> { return this.#release(this); }

  [Symbol.asyncIterator](): AsyncIterator<TrapItem, undefined, undefined> {
    return {
      next: () => {
        const queued = this.#queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { this.#waiting.push(resolve); });
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    };
  }
}

/** What the adapter holds: the public members of its trap, frozen, never the runner's own handle on it. */
export function publicTrap(trap: Trap): SignalTrap<TrapSignal> {
  return Object.freeze({
    signals: trap.signals, interruptBuffer: trap.interruptBuffer, untrap: () => trap.untrap(),
    [Symbol.asyncIterator]: () => trap[Symbol.asyncIterator](),
  });
}
