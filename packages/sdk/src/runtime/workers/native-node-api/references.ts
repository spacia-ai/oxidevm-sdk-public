import { NapiFailure } from "./errors.js";

type Held = { readonly value: unknown };
type Reference = { readonly environment: bigint; readonly rooted: boolean; readonly finalizer: bigint; count: number; strong: Held | undefined; readonly weak: WeakRef<WeakKey> | undefined };
type Slot = { generation: number; reference: Reference | undefined };
const capacity = 4096, maximumGeneration = 0xfffff;
const Number = globalThis.Number, BigInt = globalThis.BigInt, floor = Math.floor;
const symbolKeyFor = Symbol.keyFor, NativeWeakRef = WeakRef, apply = Reflect.apply;
const free: number[] = [], freePop = Reflect.get(free, "pop"), freePush = Reflect.get(free, "push");
const deref: unknown = Reflect.get(NativeWeakRef.prototype, "deref");
function weakable(value: unknown): value is WeakKey {
  return (typeof value === "object" && value !== null) || typeof value === "function" || (typeof value === "symbol" && symbolKeyFor(value) === undefined);
}

/** One owner for reference reachability, live capacity and reused-slot generations. */
export class NativeReferences {
  readonly #slots: Slot[] = [];
  readonly #free: number[] = [];
  #closed = false;
  constructor(readonly prefix: bigint) {}
  create(value: unknown, count: number, primitiveReferences: boolean, environment: bigint, finalizer = 0n): bigint {
    if (!primitiveReferences && !((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "symbol")) throw new NapiFailure(1);
    if (this.#closed || (this.#free.length === 0 && this.#slots.length === capacity)) throw new NapiFailure(9);
    const index = apply(freePop, this.#free, []) ?? this.#slots.length, slot = this.#slots[index] ?? { generation: 0, reference: undefined };
    const rooted = typeof value === "symbol" && symbolKeyFor(value) !== undefined;
    slot.generation++;
    // Registered symbols cannot enter WeakRef, but V8 retains them through its global registry.
    slot.reference = { environment, rooted, finalizer, count, strong: count === 0 && !rooted ? undefined : { value }, weak: weakable(value) ? new NativeWeakRef(value) : undefined };
    this.#slots[index] = slot;
    return this.prefix | BigInt(slot.generation * capacity + index);
  }
  #slot(identity: bigint, environment: bigint): Slot & { reference: Reference } {
    if (this.#closed || identity < 0n || (identity >> 32n) !== (this.prefix >> 32n)) throw new NapiFailure(1);
    const value = Number(identity & 0xffff_ffffn), slot = this.#slots[value % capacity];
    if (slot === undefined || slot.generation !== floor(value / capacity) || slot.reference?.environment !== environment) throw new NapiFailure(1);
    return { ...slot, reference: slot.reference };
  }
  #held(reference: Reference): Held | undefined {
    if (reference.strong !== undefined) return reference.strong;
    if (reference.weak === undefined) return undefined;
    if (typeof deref !== "function") throw new NapiFailure(9);
    const value: unknown = apply(deref, reference.weak, []);
    return value === undefined ? undefined : { value };
  }
  get(identity: bigint, environment: bigint): Held | undefined { return this.#held(this.#slot(identity, environment).reference); }
  delete(identity: bigint, environment: bigint): bigint {
    const current = this.#slot(identity, environment), index = Number(identity & 0xfffn), slot = this.#slots[index];
    if (slot === undefined) throw new NapiFailure(1);
    slot.reference = undefined;
    // Exhausted generations retire their slot instead of aliasing a stale reference.
    if (current.generation < maximumGeneration) apply(freePush, this.#free, [index]);
    return current.reference.finalizer;
  }
  ref(identity: bigint, environment: bigint): number {
    const reference = this.#slot(identity, environment).reference, held = this.#held(reference);
    if (held === undefined) return 0;
    reference.count = (reference.count + 1) >>> 0; reference.strong = held; return reference.count;
  }
  unref(identity: bigint, environment: bigint): number {
    const reference = this.#slot(identity, environment).reference;
    if (reference.count === 0) throw new NapiFailure(9);
    reference.count--; if (reference.count === 0 && !reference.rooted) reference.strong = undefined;
    return reference.count;
  }
  dispose(): void { this.#closed = true; this.#slots.length = 0; this.#free.length = 0; }
}
