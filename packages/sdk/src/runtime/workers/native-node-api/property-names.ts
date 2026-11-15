import { VMError } from "../../errors.js";
import { nativeIsProxy } from "../../proxy-brand.js";

/**
 * napi_get_all_property_names as pinned Node 24.18.1 answers it: V8's KeyAccumulator collecting
 * Object::GetPropertyNames (ADR 0026, 2.11; rows in property-names.controls.json). Per object it
 * takes integer indices, then strings, then symbols, as Reflect.ownKeys orders them; a key seen
 * nearer the receiver hides a later one, and under the enumerable filter so does a non-enumerable
 * one. A Proxy answers through its traps: ownKeys, then getOwnPropertyDescriptor only for the
 * enumerable filter, which is the only attribute filter V8 applies to a proxy's keys. Where V8's
 * answer depends on how it stores an object's elements, which JavaScript cannot see, the call
 * fails as a limitation instead of guessing.
 */
const WRITABLE = 1, ENUMERABLE = 2, CONFIGURABLE = 4, SKIP_STRINGS = 8, SKIP_SYMBOLS = 16;
const ownKeys = Reflect.ownKeys, descriptorOf = Reflect.getOwnPropertyDescriptor, prototypeOf = Reflect.getPrototypeOf, apply = Reflect.apply;
const stringValue: unknown = Reflect.get(String.prototype, "valueOf");
type Key = string | symbol;
interface OwnKeys { readonly keys: readonly Key[]; readonly hiding: readonly Key[] }

export function allPropertyNames(receiver: object, prototypes: boolean, filter: number, keepNumbers: boolean): (string | number | symbol)[] {
  const keys = new Set<Key>(), hidden = new Set<Key>();
  for (let current: object | null = receiver; current !== null; current = prototypeOf(current)) {
    // V8 starts hiding keys only after the object that first named a hiding key.
    const checks = hidden.size > 0;
    const own = nativeIsProxy(current) ? proxyKeys(current, filter) : ordinaryKeys(current, filter, prototypes);
    for (const key of own.keys) if (!(checks && hidden.has(key))) keys.add(key);
    for (const key of own.hiding) hidden.add(key);
    if (!prototypes) break;
  }
  return Array.from(keys, key => keepNumbers && typeof key === "string" && arrayIndex(key) ? Number(key) : key);
}

function skippedType(key: Key, filter: number): boolean {
  return typeof key === "symbol" ? (filter & SKIP_SYMBOLS) !== 0 : (filter & SKIP_STRINGS) !== 0;
}

function proxyKeys(proxy: object, filter: number): OwnKeys {
  const keys: Key[] = [], hiding: Key[] = [];
  for (const key of ownKeys(proxy)) {
    if (skippedType(key, filter)) continue;
    if ((filter & ENUMERABLE) !== 0) {
      const descriptor = descriptorOf(proxy, key);
      if (descriptor === undefined) continue;
      if (descriptor.enumerable !== true) { hiding.push(key); continue; }
    }
    keys.push(key);
  }
  return { keys, hiding };
}

function ordinaryKeys(object: object, filter: number, prototypes: boolean): OwnKeys {
  const keys: Key[] = [], hiding: Key[] = [], characters = stringLength(object), all = ownKeys(object);
  const attributes = (filter & (WRITABLE | ENUMERABLE | CONFIGURABLE)) !== 0, elements = attributes ? elementAttributes(object, all, characters) : undefined;
  for (const key of all) {
    if (skippedType(key, filter)) continue;
    // V8 adds a String object's own characters whatever their attributes.
    if (typeof key === "string" && characters !== undefined && arrayIndex(key) && Number(key) < characters) { keys.push(key); continue; }
    if (attributes) {
      const descriptor = descriptorOf(object, key);
      if (descriptor === undefined) continue;
      if ((filter & ENUMERABLE) !== 0 && descriptor.enumerable !== true) { if (prototypes) hiding.push(key); continue; }
      const writable = !Object.hasOwn(descriptor, "value") || descriptor.writable === true;
      const excluded = (filter & WRITABLE) !== 0 && !writable || (filter & CONFIGURABLE) !== 0 && descriptor.configurable !== true;
      if (excluded) {
        if (typeof key === "string" && arrayIndex(key) && elements === "uniform") throw elementsKindUnknown();
        continue;
      }
    }
    keys.push(key);
  }
  return { keys, hiding };
}

/** V8 ignores the writable and configurable filters for elements it stores fast, which every
 * one of them shares, and applies them to dictionary elements. Attributes that differ between
 * elements, accessors or non-enumerable elements mean dictionary storage; elements that all
 * share one non-default attribute set (a frozen or sealed array) may be either. */
function elementAttributes(object: object, keys: readonly Key[], characters: number | undefined): "uniform" | "dictionary" | "default" {
  let shared: string | undefined;
  for (const key of keys) {
    if (typeof key !== "string" || !arrayIndex(key) || characters !== undefined && Number(key) < characters) continue;
    const descriptor = descriptorOf(object, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return "dictionary";
    const signature = `${String(descriptor.writable)}:${String(descriptor.configurable)}`;
    if (shared !== undefined && shared !== signature) return "dictionary";
    shared = signature;
  }
  return shared === undefined || shared === "true:true" ? "default" : "uniform";
}

function elementsKindUnknown(): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", "napi_get_all_property_names cannot tell how V8 would store these elements", { lateFailure: "unsupported-node-api", subject: "napi_get_all_property_names" });
}

/** The length of a String object's own characters, which only String objects have. */
function stringLength(object: object): number | undefined {
  if (typeof stringValue !== "function") return undefined;
  try {
    const value: unknown = apply(stringValue, object, []);
    return typeof value === "string" ? value.length : undefined;
  } catch { return undefined; }
}

/** A canonical array index: an integer below 2^32 - 1 written without leading zeros. */
function arrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) <= 4_294_967_294;
}
