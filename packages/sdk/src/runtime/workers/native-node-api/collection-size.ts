import { protocol } from "../../js-process/codec.js";

const mapPrototype = Reflect.getPrototypeOf(new Map<unknown, unknown>()), setPrototype = Reflect.getPrototypeOf(new Set<unknown>());
const mapSize: unknown = mapPrototype === null ? undefined : Reflect.getOwnPropertyDescriptor(mapPrototype, "size")?.get;
const setSize: unknown = setPrototype === null ? undefined : Reflect.getOwnPropertyDescriptor(setPrototype, "size")?.get;
const apply = Reflect.apply, safeInteger = Number.isSafeInteger;

function size(getter: unknown, collection: object): number {
  if (typeof getter !== "function") protocol("Native collection size intrinsic is unavailable");
  const result: unknown = apply(getter, collection, []);
  if (typeof result !== "number" || !safeInteger(result) || result < 0) protocol("Invalid native collection size");
  return result;
}

export function nativeMapSize(map: ReadonlyMap<unknown, unknown>): number { return size(mapSize, map); }
export function nativeSetSize(set: ReadonlySet<unknown>): number { return size(setSize, set); }
