import { protocol } from "../../js-process/codec.js";
import { nativeMapSize } from "./collection-size.js";

const Number = globalThis.Number, BigInt = globalThis.BigInt, Set = globalThis.Set, floor = Math.floor;

type Kind = "function" | "finalizer";
type Entry = { readonly kind: Kind; readonly token: object };
const entries = new Map<bigint, Entry>(), slots = new Set<bigint>(), apply = Reflect.apply;
const entryGet = Reflect.get(entries, "get"), entrySet = Reflect.get(entries, "set"), entryHas = Reflect.get(entries, "has"), entryDelete = Reflect.get(entries, "delete"), entryKeys = Reflect.get(entries, "keys"), entryIterator = Reflect.get(entries, Symbol.iterator);
const slotHas = Reflect.get(slots, "has"), slotAdd = Reflect.get(slots, "add");
const generations = new Map<number, number>(), generationGet = Reflect.get(generations, "get"), generationSet = Reflect.get(generations, "set");
const entryNext = Reflect.get(apply(entryIterator, entries, []), "next"), keyNext = Reflect.get(apply(entryKeys, entries, []), "next");
const NativeFinalizationRegistry = FinalizationRegistry, registry = new NativeFinalizationRegistry<bigint>(() => undefined);
const register = Reflect.get(registry, "register"), unregister = Reflect.get(registry, "unregister");
export type NativeCallbackEffects = {
  claim(identity: bigint, environment: bigint): void;
  retire(identity: bigint): void;
  finalize(identity: bigint): void;
};

/** JavaScript reachability owns retirement; the guest owns callback slots and their generations. */
export class NativeCallbacks {
  readonly #entries = new Map<bigint, Entry>();
  /** The last generation claimed in each slot the helper has used. */
  readonly #generations = new Map<number, number>();
  readonly #slots: number;
  readonly #registry: FinalizationRegistry<bigint>;
  #closed = false;
  /**
   * `slots`: the helper's callback table size, which its bridge version fixes (`nativeCallbackSlots`); an identity is
   * `generation * slots + slot`. The bridge always passes it; without it the table is the one before bridge 18.
   */
  constructor(readonly prefix: bigint, readonly effects: NativeCallbackEffects, slots = 4096) {
    this.#slots = slots;
    this.#registry = new NativeFinalizationRegistry(identity => { this.#finish(identity, true); });
  }
  get live(): number { return nativeMapSize(this.#entries); }
  active(identity: bigint): boolean { return apply(entryHas, this.#entries, [identity]); }
  validate(identity: bigint): void {
    if (this.#closed || identity < 0n || identity >> 32n !== this.prefix >> 32n) protocol("Invalid native callback environment");
    const local = Number(identity & 0xffff_ffffn), slots = this.#slots, generation = floor(local / slots);
    const claimed: unknown = apply(generationGet, this.#generations, [local % slots]), previous = typeof claimed === "number" ? claimed : 0;
    if (generation === 0 || generation <= previous || apply(entryHas, this.#entries, [this.prefix | BigInt(previous * slots + local % slots)])) protocol("Stale native callback generation");
  }
  validateAll(identities: readonly bigint[]): void {
    const slots = new Set<bigint>();
    for (const identity of identities) {
      this.validate(identity);
      const slot = (identity & 0xffff_ffffn) % BigInt(this.#slots);
      if (apply(slotHas, slots, [slot])) protocol("Conflicting native callback slots");
      apply(slotAdd, slots, [slot]);
    }
  }
  add(value: object, identity: bigint, kind: Kind, environment: bigint): void {
    apply(register, this.#registry, [value, identity, this.#claim(identity, kind, environment)]);
  }
  /** node_api_post_finalizer (ADR 0026, 2.13): the slot stays claimed until `later` runs the
   * finalizer, or teardown runs it with the other finalizers; whichever is first runs it once. */
  post(identity: bigint, environment: bigint, later: (run: () => void) => void): void {
    this.#claim(identity, "finalizer", environment);
    later(() => { this.#finish(identity, true); });
  }
  #claim(identity: bigint, kind: Kind, environment: bigint): object {
    this.validate(identity); this.effects.claim(identity, environment);
    const local = Number(identity & 0xffff_ffffn), token = {};
    apply(generationSet, this.#generations, [local % this.#slots, floor(local / this.#slots)]);
    apply(entrySet, this.#entries, [identity, { kind, token }]);
    return token;
  }
  #finish(identity: bigint, collect: boolean): void {
    const entry = apply(entryGet, this.#entries, [identity]); if (entry === undefined) return;
    apply(entryDelete, this.#entries, [identity]); apply(unregister, this.#registry, [entry.token]);
    if (collect && entry.kind === "finalizer") this.effects.finalize(identity); else this.effects.retire(identity);
  }
  cancel(identity: bigint): void { this.#finish(identity, false); }
  finalize(): void {
    const iterator = apply(entryIterator, this.#entries, []);
    for (let step = apply(entryNext, iterator, []); step.done !== true; step = apply(entryNext, iterator, [])) {
      const [identity, entry] = step.value;
      if (entry.kind === "finalizer") this.#finish(identity, true);
    }
  }
  dispose(): void {
    if (this.#closed) return;
    this.finalize();
    const iterator = apply(entryKeys, this.#entries, []);
    for (let step = apply(keyNext, iterator, []); step.done !== true; step = apply(keyNext, iterator, [])) this.#finish(step.value, false);
    this.#closed = true;
  }
}
