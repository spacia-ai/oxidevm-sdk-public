import { VMError } from "../../runtime/errors.js";
import { signalSet, signalsOf, type MaskHow, type SignalArrival, type SignalDisposition, type TrappableSignalNumber } from "../../runtime/js-process/signals.js";
import { signalName as nameOfSignal, signalNumber, type SignalName } from "../../runtime/process-signals.js";
import type { BlockableSignal, ProcessSignals, SignalTrap, TrapSignal } from "../capabilities.js";
import { publicTrap, Trap, trapEntry, trapNumber } from "./signal-trap.js";

/**
 * What the runner needs of its process's signals (JS process protocol 4, engine ADR 0027). The module runner's bootstrap
 * binds it to the process's Linux client (`clientSignals`); tests supply their own.
 */
export interface SignalTransport {
  /** OXJR 65550: sets `signal`'s host disposition and resolves with the previous one once Rust installed it. */
  setDisposition(signal: TrappableSignalNumber, disposition: SignalDisposition): Promise<SignalDisposition>;
  /** Hands over each arrival Rust caught for the process exactly once (`takeArrivals` order); one listener serves the process. */
  listen(listener: (arrivals: readonly SignalArrival[]) => void): void;
  /** The interrupt word at byte 8 of the signal buffer, in Pyodide's interrupt-buffer format. */
  readonly interruptWord: Int32Array<SharedArrayBuffer>;
  /** OXJR 14: changes the process's mask and resolves with the previous one (bit n-1 for signal n). */
  mask(how: MaskHow, set: bigint): Promise<bigint>;
  /** OXJR 127: the pending signals the process blocks. */
  pending(): Promise<bigint>;
  /** kill(getpid(), signal) through OXJR 62: Rust applies the process's mask and disposition. */
  kill(signal: TrappableSignalNumber): Promise<void>;
}

/** A signal a module may block: any but SIGKILL and SIGSTOP, which Linux never blocks. */
function blockable(value: unknown): number {
  const number = signalNumber(value);
  if (number === null || number === 9 || number === 19) throw new VMError("INVALID_ARGUMENT", `${String(value)} is not a signal a module can block`);
  return number;
}
/** The named signals of a mask; musl's reserved 32 to 34 have no name and are left out. */
function namesOf(set: bigint): ReadonlySet<SignalName> {
  return new Set(signalsOf(set).flatMap(number => { const name = nameOfSignal(number); return name === null ? [] : [name]; }));
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
    this.api = Object.freeze({
      trap: <const S extends readonly TrapSignal[]>(signals: S) => this.#trap<S[number]>(signals), raise: (signal: TrapSignal) => this.#raise(signal),
      block: (signals: readonly BlockableSignal[]) => this.#mask("block", signals), unblock: (signals: readonly BlockableSignal[]) => this.#mask("unblock", signals),
      pending: async () => namesOf(await this.#transport.pending()),
    });
  }

  /** The runner's exit: every trap is untrapped, so a signal during the rest of the exit has its default action. */
  async close(): Promise<void> {
    await Promise.allSettled([...new Set(this.#trapped.values())].map(trap => this.#untrap(trap)));
  }

  /** The adapter's view of a trap of `S`: the runner's trap yields exactly the items the public type names for `S`. */
  async #trap<S extends TrapSignal>(input: unknown): Promise<SignalTrap<S>> {
    if (!Array.isArray(input) || input.length === 0) throw new VMError("INVALID_ARGUMENT", "trap needs a list of one or more signals");
    const numbers = Array.from<unknown>(input).map(trapNumber).sort((left, right) => left - right);
    if (new Set(numbers).size !== numbers.length) throw new VMError("INVALID_ARGUMENT", "trap names each signal once");
    const taken = numbers.find(number => this.#trapped.has(number));
    if (taken !== undefined) throw new VMError("INVALID_ARGUMENT", `${String(trapEntry(taken))} is already trapped`);
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
    trap.installed(installed);
    const held = publicTrap(trap);
    if (!holdsOnly<S>(held, numbers)) throw new VMError("PROTOCOL_ERROR", "A trap holds a signal it was not asked for");
    return held;
  }

  async #untrap(trap: Trap): Promise<void> {
    if (trap.ended) return;
    trap.end();
    const numbers = trap.signals.map(trapNumber);
    for (const number of numbers) {
      this.#trapped.delete(number);
      // An interrupt this trap has not taken goes with its pending signals.
      Atomics.compareExchange(this.#transport.interruptWord, 0, number, 0);
    }
    for (const number of numbers) await this.#transport.setDisposition(number, "default");
  }

  /** Blocks or unblocks `input` and answers the previous mask. A blocked trapped signal stays pending until unblocked. */
  async #mask(how: "block" | "unblock", input: unknown): Promise<ReadonlySet<SignalName>> {
    if (!Array.isArray(input)) throw new VMError("INVALID_ARGUMENT", `${how} needs a list of signals`);
    return namesOf(await this.#transport.mask(how, signalSet(Array.from<unknown>(input).map(blockable))));
  }

  /**
   * raise(3) is kill(getpid(), signal): Rust applies the process's mask and disposition, so a trapped signal reaches its
   * trap, a blocked one stays pending, an ignored one does nothing, and any other ends the process without settling.
   */
  async #raise(input: unknown): Promise<void> {
    await this.#transport.kill(trapNumber(input));
  }

  #dispatch(arrivals: readonly SignalArrival[]): void {
    for (const arrival of arrivals) this.#trapped.get(arrival.signal)?.deliver(arrival);
  }
}

/**
 * Whether `trap` holds only signals among `requested`, the checked numbers of the adapter's list of `S`: then it yields
 * only arrivals of those signals, which is what `SignalTrap<S>` names.
 */
function holdsOnly<S extends TrapSignal>(trap: SignalTrap<TrapSignal>, requested: readonly number[]): trap is SignalTrap<S> {
  return trap.signals.every(signal => requested.includes(trapNumber(signal)));
}
