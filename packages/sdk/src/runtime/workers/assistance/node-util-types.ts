import { nativeIsPromise } from "../../promise-brand.js";

/** Restricted legacy classifiers include spoofable tags and prototype checks.
 * Exact Promise queries are enabled only in profiles that require the native primitive. */
const tag = ((): ((value: unknown) => string) => {
  const method: unknown = Object.getOwnPropertyDescriptor(Object.prototype, "toString")?.value;
  if (typeof method !== "function") throw new TypeError("Object.prototype.toString is unavailable");
  return value => {
    const text: unknown = Reflect.apply(method, value, []);
    return typeof text === "string" ? text.slice(8, -1) : "";
  };
})();

const typedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
if (typeof typedArrayPrototype !== "object" || typedArrayPrototype === null) throw new TypeError("%TypedArray%.prototype is unavailable");
const TYPED_ARRAY_PROTOTYPE: object = typedArrayPrototype;

/** The `%TypedArray%.prototype[Symbol.toStringTag]` getter answers the
 * element type for a real typed array and undefined for anything else. */
function typedArrayTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name: unknown = Reflect.get(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag, value);
  return typeof name === "string" ? name : undefined;
}

function isTag(name: string): (value: unknown) => boolean {
  return value => typeof value === "object" && value !== null && tag(value) === name;
}

function isTyped(name: string): (value: unknown) => boolean {
  return value => typedArrayTag(value) === name;
}

const isBoxed = (constructor: unknown, name: string) => (value: unknown): boolean =>
  typeof value === "object" && value !== null && tag(value) === name && Object.getPrototypeOf(value) !== null
  && (typeof constructor !== "function" || value instanceof constructor || tag(value) === name);

export const nodeUtilTypes = Object.freeze({
  isAnyArrayBuffer: (value: unknown): boolean => value instanceof ArrayBuffer || value instanceof SharedArrayBuffer,
  isArrayBuffer: (value: unknown): boolean => value instanceof ArrayBuffer,
  isSharedArrayBuffer: (value: unknown): boolean => value instanceof SharedArrayBuffer,
  isArrayBufferView: (value: unknown): boolean => ArrayBuffer.isView(value),
  isTypedArray: (value: unknown): boolean => typedArrayTag(value) !== undefined,
  isUint8Array: isTyped("Uint8Array"), isUint8ClampedArray: isTyped("Uint8ClampedArray"), isUint16Array: isTyped("Uint16Array"),
  isUint32Array: isTyped("Uint32Array"), isInt8Array: isTyped("Int8Array"), isInt16Array: isTyped("Int16Array"),
  isInt32Array: isTyped("Int32Array"), isFloat32Array: isTyped("Float32Array"), isFloat64Array: isTyped("Float64Array"),
  isBigInt64Array: isTyped("BigInt64Array"), isBigUint64Array: isTyped("BigUint64Array"),
  isDataView: (value: unknown): boolean => value instanceof DataView,
  isDate: isTag("Date"), isRegExp: isTag("RegExp"), isPromise: (value: unknown): boolean => value instanceof Promise,
  isMap: isTag("Map"), isSet: isTag("Set"), isWeakMap: isTag("WeakMap"), isWeakSet: isTag("WeakSet"),
  isMapIterator: isTag("Map Iterator"), isSetIterator: isTag("Set Iterator"),
  isArgumentsObject: isTag("Arguments"), isModuleNamespaceObject: isTag("Module"),
  isGeneratorObject: isTag("Generator"),
  isAsyncFunction: (value: unknown): boolean => typeof value === "function" && ["AsyncFunction", "AsyncGeneratorFunction"].includes(tag(value)),
  isGeneratorFunction: (value: unknown): boolean => typeof value === "function" && ["GeneratorFunction", "AsyncGeneratorFunction"].includes(tag(value)),
  isNativeError: (value: unknown): boolean => value instanceof Error || (typeof value === "object" && value !== null && tag(value) === "Error"),
  isNumberObject: isBoxed(Number, "Number"), isStringObject: isBoxed(String, "String"), isBooleanObject: isBoxed(Boolean, "Boolean"),
  isBigIntObject: isBoxed(BigInt, "BigInt"), isSymbolObject: isBoxed(Symbol, "Symbol"),
  isBoxedPrimitive: (value: unknown): boolean => typeof value === "object" && value !== null
    && ["Number", "String", "Boolean", "BigInt", "Symbol"].includes(tag(value)),
  isCryptoKey: (value: unknown): boolean => typeof CryptoKey !== "undefined" && value instanceof CryptoKey,
  isKeyObject: (): boolean => false,
  // A Proxy or a host external is indistinguishable from JavaScript.
  isProxy: (): boolean => false, isExternal: (): boolean => false,
});

export const exactPromiseUtilTypes = Object.freeze({ ...nodeUtilTypes, isPromise: nativeIsPromise });
