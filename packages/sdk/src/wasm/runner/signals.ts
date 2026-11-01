import { VMError } from "../../runtime/errors.js";
import type { SignalDisposition, TrappableSignalNumber } from "../../runtime/js-process/signals.js";
import type { ProcessSignals, SignalTrap, TrappableSignal } from "../capabilities.js";

/**
 * What the runner needs of its process's signals (JS process protocol 4, engine ADR 0027). The module runner's bootstrap
 * binds it to the process's Linux client (`clientSignals`); tests supply their own.
 */
export interface SignalTransport {
  /** OXJR 65550: sets `signal`'s host disposition and resolves with the previous one once Rust installed it. */
  setDisposition(signal: TrappableSignalNumber, disposition: SignalDisposition): Promise<SignalDisposition>;
  /** Hands over each signal Rust caught for the process exactly once, lowest first; one listener serves the process. */
  listen(listener: (signals: readonly TrappableSignalNumber[]) => void): void;
  /** Word 1 of the signal words, in Pyodide's interrupt-buffer format. */
  readonly interruptWord: Int32Array<SharedArrayBuffer>;
  /** Ends the process killed by `signal`; Rust reports the exit, and nothing follows. */
  signaled(signal: TrappableSignalNumber): void;
}

const NUMBERS: Readonly<Record<TrappableSignal, TrappableSignalNumber>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15 };
const TRAPPABLE = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGTERM"] as const satisfies readonly TrappableSignal[];
const NAMES: ReadonlyMap<TrappableSignalNumber, TrappableSignal> = new Map(TRAPPABLE.map(name => [NUMBERS[name], name]));

function isTrappable(value: unknown): value is TrappableSignal {
  return TRAPPABLE.some(name => name === value);
}

/** A trappable signal's name, from the adapter's untrusted argument; anything else, SIGKILL and SIGSTOP included, is refused. */
function signalName(value: unknown): TrappableSignal {
  if (!isTrappable(value)) throw new VMError("INVALID_ARGUMENT", `${String(value)} is not a signal a module can trap: SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1 or SIGUSR2`);
  return value;
}

function nameOf(number: TrappableSignalNumber): TrappableSignal {
  const name = NAMES.get(number);
  if (name === undefined) throw new VMError("PROTOCOL_ERROR", `Signal ${String(number)} is not trappable`);
  return name;
}

/** One trap: the signals it took, delivered through its iterator until it is untrapped. */
class Trap implements SignalTrap {
  readonly interruptBuffer: Int32Array;
  readonly #release: (trap: Trap) => Promise<void>;
  readonly #queue: TrappableSignal[] = [];
  readonly #waiting: ((result: IteratorResult<TrappableSignal, undefined>) => void)[] = [];
  #signals: readonly TrappableSignal[] = Object.freeze([]);
  #ended = false;

  constructor(interruptBuffer: Int32Array, release: (trap: Trap) => Promise<void>) { this.interruptBuffer = interruptBuffer; this.#release = release; }
  get signals(): readonly TrappableSignal[] { return this.#signals; }
  get ended(): boolean { return this.#ended; }
  installed(signals: readonly TrappableSignal[]): void { this.#signals = Object.freeze([...signals]); }

  /** A pending standard signal is pending once, as in Linux: a second delivery before the module takes the first adds nothing. */
  deliver(signal: TrappableSignal): void {
    if (this.#ended) return;
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) waiting({ value: signal, done: false });
    else if (!this.#queue.includes(signal)) this.#queue.push(signal);
  }

  /** Drops pending signals and ends every iteration. */
  end(): void {
    this.#ended = true; this.#queue.length = 0;
    for (const waiting of this.#waiting.splice(0)) waiting({ value: undefined, done: true });
  }

  untrap(): Promise<void> { return this.#release(this); }

  [Symbol.asyncIterator](): AsyncIterator<TrappableSignal, undefined, undefined> {
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
function publicTrap(trap: Trap): SignalTrap {
  return Object.freeze({
    signals: trap.signals, interruptBuffer: trap.interruptBuffer, untrap: () => trap.untrap(),
    [Symbol.asyncIterator]: () => trap[Symbol.asyncIterator](),
  });
}

/**
 * `host.process.signals` of one module process (capability `process.signals`). Trapping a signal installs Rust's caught
 * disposition with the interrupt flag and without restart, so a blocking request of the process returns EINTR when the
 * signal arrives; the signal then reaches the trap instead of its default action. A signal the process inherited as
 * ignored stays ignored. Untrapping restores the default. Raising an untrapped signal ends the process killed by it.
 */
export class RunnerSignals {
  readonly api: ProcessSignals;
  readonly #transport: SignalTransport;
  /** The trap that holds each signal, from the moment a trap asks for it. */
  readonly #trapped = new Map<TrappableSignalNumber, Trap>();
  #listening = false;

  constructor(transport: SignalTransport) {
    this.#transport = transport;
    this.api = Object.freeze({ trap: (signals: readonly TrappableSignal[]) => this.#trap(signals), raise: (signal: TrappableSignal) => this.#raise(signal) });
  }

  /** The runner's exit: every trap is untrapped, so a signal during the rest of the exit has its default action. */
  async close(): Promise<void> {
    await Promise.allSettled([...new Set(this.#trapped.values())].map(trap => this.#untrap(trap)));
  }

  async #trap(input: unknown): Promise<SignalTrap> {
    if (!Array.isArray(input) || input.length === 0) throw new VMError("INVALID_ARGUMENT", "trap needs a list of one or more signals");
    const names = Array.from<unknown>(input).map(signalName);
    if (new Set(names).size !== names.length) throw new VMError("INVALID_ARGUMENT", "trap names each signal once");
    const numbers = names.map(name => NUMBERS[name]).sort((left, right) => left - right);
    const taken = numbers.find(number => this.#trapped.has(number));
    if (taken !== undefined) throw new VMError("INVALID_ARGUMENT", `${nameOf(taken)} is already trapped`);
    if (!this.#listening) { this.#listening = true; this.#transport.listen(signals => { this.#dispatch(signals); }); }
    const trap = new Trap(this.#transport.interruptWord, released => this.#untrap(released)), installed: TrappableSignalNumber[] = [];
    for (const number of numbers) this.#trapped.set(number, trap);
    try {
      for (const number of numbers) {
        if (await this.#transport.setDisposition(number, "caught") !== "ignore") { installed.push(number); continue; }
        // Inherited SIG_IGN, as from nohup or a background job: like a Linux program, the module leaves it ignored.
        this.#trapped.delete(number);
        await this.#transport.setDisposition(number, "ignore");
      }
    } catch (error: unknown) {
      for (const number of numbers) if (this.#trapped.get(number) === trap) this.#trapped.delete(number);
      trap.end();
      await Promise.allSettled(installed.map(number => this.#transport.setDisposition(number, "default")));
      throw error;
    }
    trap.installed(installed.map(nameOf));
    return publicTrap(trap);
  }

  async #untrap(trap: Trap): Promise<void> {
    if (trap.ended) return;
    trap.end();
    const numbers = trap.signals.map(name => NUMBERS[name]);
    for (const number of numbers) {
      this.#trapped.delete(number);
      // An interrupt this trap has not taken goes with its pending signals.
      Atomics.compareExchange(this.#transport.interruptWord, 0, number, 0);
    }
    for (const number of numbers) await this.#transport.setDisposition(number, "default");
  }

  async #raise(input: unknown): Promise<void> {
    const name = signalName(input), number = NUMBERS[name];
    const trap = this.#trapped.get(number);
    // A trapped signal reaches its trap, as raise(3) runs a handler.
    if (trap !== undefined) { trap.deliver(name); return; }
    // Otherwise its disposition decides: an ignored signal does nothing, any other ends the process killed by it.
    if (await this.#transport.setDisposition(number, "ignore") === "ignore") return;
    this.#transport.signaled(number);
    await new Promise<never>(() => undefined);
  }

  #dispatch(numbers: readonly TrappableSignalNumber[]): void {
    for (const number of numbers) this.#trapped.get(number)?.deliver(nameOf(number));
  }
}
