import { VMError } from "./errors.js";

const apply = Reflect.apply, define = Reflect.defineProperty, describe = Reflect.getOwnPropertyDescriptor, prototypeOf = Reflect.getPrototypeOf;
const NativePromise = Promise, promisePrototype: object = Promise.prototype, species = Symbol.species;
const then: unknown = Reflect.get(promisePrototype, "then"), mapHas: unknown = Reflect.get(Map.prototype, "has"), typeErrorPrototype: object = TypeError.prototype;
const descriptor = describe(Promise, "isPromise");
const intrinsic: unknown = descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
type NativePredicate = (value: unknown) => unknown;
function callable(value: unknown): value is NativePredicate { return typeof value === "function"; }
type Predicate = { readonly kind: "available"; readonly invoke: NativePredicate } | { readonly kind: "unavailable" };
// The authenticated worker bootstrap runs before application modules or polyfills.
const predicate: Predicate = callable(intrinsic) ? { kind: "available", invoke: intrinsic } : { kind: "unavailable" };
export const nativePromiseCapability: 0 | 1 = predicate.kind === "available" ? 1 : 0;

/*
 * The practical check (engine ADR 0026, practical profile), for engines without Promise.isPromise. The intrinsic
 * `then` throws on a receiver that is no promise before it reads anything. On a promise it next reads the constructor
 * and its species: for that one call, both intrinsic properties throw a sentinel, so nothing is attached to the
 * promise and its rejection is reported as before. A promise whose own constructor or species is found first runs
 * that accessor once and, when `then` completes, counts as handled. A TypeError other than the sentinel is the
 * engine's incompatible-receiver sentence, which Map.prototype.has words the same way for the same receiver, unless a
 * promise's own constructor lookup threw it.
 */
const noop = (): undefined => undefined, sentinel = new Error("Promise brand sentinel");
Object.freeze(sentinel);
const speciesDescriptor = describe(NativePromise, species), speciesGetter: unknown = speciesDescriptor?.get;
let armed = false;
const constructorTrap: PropertyDescriptor = { get(): unknown { if (armed) { armed = false; throw sentinel; } return NativePromise; }, enumerable: false, configurable: true };
const speciesTrap: PropertyDescriptor = { get(this: unknown): unknown { if (armed) { armed = false; throw sentinel; } return callable(speciesGetter) ? apply(speciesGetter, this, []) : undefined; }, enumerable: false, configurable: true };

/** Runs `action` while reading a promise's intrinsic constructor or species throws the sentinel once `armed`. */
function trapped<T>(action: () => T): T {
  const constructor = describe(promisePrototype, "constructor"), ownSpecies = describe(NativePromise, species);
  const constructorSet = constructor !== undefined && define(promisePrototype, "constructor", constructorTrap);
  const speciesSet = ownSpecies !== undefined && define(NativePromise, species, speciesTrap);
  try { return action(); } finally {
    armed = false;
    if (constructorSet) define(promisePrototype, "constructor", constructor);
    if (speciesSet) define(NativePromise, species, ownSpecies);
  }
}
/** The message of a TypeError this realm's engine made: an own data string, read without running application code. */
function message(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || prototypeOf(error) !== typeErrorPrototype) return undefined;
  const own = describe(error, "message"), value: unknown = own?.value;
  return typeof value === "string" ? value : undefined;
}
function thrown(method: unknown, value: unknown): { readonly error: unknown } | undefined {
  if (!callable(method)) return { error: undefined };
  try { apply(method, value, [noop, noop]); return undefined; } catch (error) { return { error }; }
}
/** The sentence `then` uses for a receiver that is no promise; null for a Map, which Map.prototype.has accepts. */
type Expected = (value: unknown) => string | null | undefined;
/** Learns how this engine words an incompatible receiver, and proves it on receivers of every kind; undefined when it cannot. */
function calibrate(): Expected | undefined {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const samples: readonly unknown[] = [{}, [], noop, class { sample(): undefined { return undefined; } }, new Date(0), /x/u, new Uint8Array(1), { __proto__: null }, Object.create(promisePrototype), { [Symbol.toStringTag]: "Promise" },
    new Proxy({}, {}), new Proxy(noop, {}), new Proxy(NativePromise.resolve(0), {}), noop.bind(null), new Error("x"), new WeakMap(), revoked.proxy];
  // No trap is set here: learning the wording must not cost every worker V8's fast promise paths.
  {
    const first = message(thrown(then, {})?.error), reference = message(thrown(mapHas, {})?.error);
    if (first === undefined || reference === undefined) return undefined;
    let start = 0; while (start < first.length && first[start] === reference[start]) start++;
    let end = 0; while (end < first.length - start && end < reference.length - start && first[first.length - 1 - end] === reference[reference.length - 1 - end]) end++;
    const own = first.slice(start, first.length - end), other = reference.slice(start, reference.length - end);
    if (own.length === 0 || other.length === 0) return undefined;
    const expected: Expected = value => {
      const failure = thrown(mapHas, value); if (failure === undefined) return null;
      const text = message(failure.error); if (text?.slice(start, start + other.length) !== other) return undefined;
      return text.slice(0, start) + own + text.slice(start + other.length);
    };
    for (const sample of samples) { const text = message(thrown(then, sample)?.error); if (text === undefined || expected(sample) !== text) return undefined; }
    return expected;
  }
}
const expected = predicate.kind === "available" || !callable(then) ? undefined : calibrate();
/** 1 when this worker answers napi_is_promise without the exact primitive (Userspace API 149). */
export const practicalPromiseCapability: 0 | 1 = expected === undefined ? 0 : 1;

/** Whether a promise with this constructor lookup could throw from `then`: an accessor, a primitive constructor or a species of its own. */
function exotic(value: object): boolean {
  let constructor: unknown;
  for (let object: object | null = value, depth = 0; ; depth++) {
    if (object === null || depth === 64) return false;
    const own = describe(object, "constructor");
    if (own !== undefined) { if (!("value" in own)) return true; constructor = own.value; break; }
    object = prototypeOf(object);
  }
  if (constructor === undefined) return false;
  if (constructor === null || (typeof constructor !== "object" && typeof constructor !== "function")) return true;
  for (let object: object | null = constructor, depth = 0; ; depth++) {
    if (object === null || depth === 64) return false;
    const own = describe(object, species);
    if (own !== undefined) return "value" in own ? own.value !== undefined && own.value !== null : own.get !== speciesGetter;
    object = prototypeOf(object);
  }
}
function practicalIsPromise(value: unknown, wording: Expected): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  // true: a promise. false: not one. undefined: `then` threw a TypeError that is not this engine's sentence for the receiver.
  const outcome = trapped((): boolean | undefined => {
    armed = true;
    try { if (callable(then)) apply(then, value, [noop, noop]); return true; }
    catch (error) {
      armed = false;
      if (error === sentinel) return true;
      const text = message(error); if (text === undefined) return true;
      const wanted = wording(value);
      return wanted === null || wanted === text ? false : undefined;
    }
  });
  return outcome ?? exotic(value);
}

export function nativeIsPromise(value: unknown): boolean {
  if (predicate.kind === "unavailable") {
    if (expected !== undefined) return practicalIsPromise(value, expected);
    // Neither the exact primitive nor a calibrated brand check: the program is remembered for full Linux.
    throw new VMError("FEATURE_NOT_AVAILABLE", "Native Promise predicate is unavailable", { api: "napi_is_promise", lateFailure: "unsupported-node-api", subject: "napi_is_promise" });
  }
  let result: unknown;
  try { result = apply(predicate.invoke, undefined, [value]); }
  catch { throw new VMError("PROTOCOL_ERROR", "Native Promise predicate failed"); }
  if (typeof result !== "boolean") throw new VMError("PROTOCOL_ERROR", "Invalid native Promise predicate result");
  return result;
}
