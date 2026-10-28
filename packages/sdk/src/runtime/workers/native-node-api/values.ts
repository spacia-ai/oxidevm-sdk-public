import { isVMError, VMError } from "../../errors.js";
import { integer } from "../../decode.js";
import { protocol } from "../../js-process/codec.js";
import { NativeBuffers } from "./buffers.js";
import { NativeHandles } from "./handles.js";
import { NativeCallbacks, type NativeCallbackEffects } from "./callbacks.js";
import { NativeReferences } from "./references.js";
import { nativeMapSize } from "./collection-size.js";
import type { AsyncContext } from "../assistance/async-context.js";
import { NativeAsyncContexts } from "./async-contexts.js";
import { decodeNativeString, encodeNativeString, readNativeUtf8 } from "./strings.js";
import { nativeBigInt64, nativeBigIntFromWords, nativeBigIntWords, nativeDate, nativeDateTime, nativeDouble, nativeDoubleBits, nativeIsDate, nativeSignedInteger, nativeUnsignedInteger } from "./extended-values.js";
import { nativeBoolean, nativeInstanceOf, nativeNumber, nativeObject, nativeSetProperty, nativeString, nativePrototypeOf, nativeHasOwn, nativeGetProperty, nativeHasProperty, nativeDeleteProperty, nativeDefineProperty, nativeFreeze, nativeSeal, nativeCreateObject, nativeApply, nativeConstruct } from "./properties.js";
import { nativeIsArrayBuffer, nativeIsDataView, nativeIsDetachedArrayBuffer, nativeIsTypedArray, nativeIsPromise, nativeIsError } from "./value-brands.js";
import { createNativeError, NativeErrorCodeFailure, NapiFailure, requiresClearException, thrownNativeError, type NativeStatus } from "./errors.js";

const Number = globalThis.Number, BigInt = globalThis.BigInt, Uint8Array = globalThis.Uint8Array, DataView = globalThis.DataView;
export interface NativeResult { readonly status: NativeStatus; readonly args: readonly bigint[]; readonly bytes: Uint8Array }
type Invoke = (callback: bigint, receiver: unknown, target: unknown, args: readonly unknown[]) => unknown;
interface Deferred { readonly promise: Promise<unknown>; resolve(value: unknown): void; reject(value: unknown): void }
type Escaped = { readonly value: unknown };
const deferreds = new Map<bigint, Deferred>(), environments = new Map<bigint, number>(), escaped = new Map<bigint, Escaped>(), applyCollection = Reflect.apply;
const deferredGet = Reflect.get(deferreds, "get"), deferredSet = Reflect.get(deferreds, "set"), deferredDelete = Reflect.get(deferreds, "delete"), clearCollection = Reflect.get(deferreds, "clear");
const environmentGet = Reflect.get(environments, "get"), environmentSet = Reflect.get(environments, "set");
const escapedGet = Reflect.get(escaped, "get"), escapedSet = Reflect.get(escaped, "set"), escapedDelete = Reflect.get(escaped, "delete");
interface Wrapped { readonly pointer: bigint; readonly finalizer: bigint }
const wrappedValues = new WeakMap<object, Wrapped>(), tags = new WeakMap<object, readonly [bigint, bigint]>();
const wrappedGet = Reflect.get(wrappedValues, "get"), wrappedSet = Reflect.get(wrappedValues, "set"), wrappedHas = Reflect.get(wrappedValues, "has"), wrappedDelete = Reflect.get(wrappedValues, "delete");
const tagGet = Reflect.get(tags, "get"), tagSet = Reflect.get(tags, "set");
type NativeValueOptions = Pick<NativeCallbackEffects, "claim" | "retire"> & { readonly runtime?: "node" | "bun" };
type NativeClassSignature = { readonly kind: "constructor" | "method"; readonly receivers: WeakSet<object> };
const NativeArray = Array, arrayFrom = Array.from;
const empty = new Uint8Array();
const createSymbol = Symbol, registeredSymbol = Symbol.for;
const capturedPromiseFactory = { constructor: Promise, create: Promise.withResolvers.bind(Promise) };
const nativePromisePrototype = Promise.prototype, promiseDescriptor = Object.getOwnPropertyDescriptor, promisePrototypeOf = Reflect.getPrototypeOf;
const ClassReceivers = WeakSet, ClassTypeError = TypeError, applyClassIntrinsic = nativeApply;
const realmGlobal = globalThis;
const classHas: unknown = Reflect.get(WeakSet.prototype, "has"), classAdd: unknown = Reflect.get(WeakSet.prototype, "add");
function object(value: unknown): object { if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new NapiFailure(2); return value; }
function key(value: unknown): PropertyKey { if (typeof value !== "string" && typeof value !== "symbol") throw new NapiFailure(4); return value; }
function scalar(value: bigint | undefined, name: string): number { if (value === undefined || value < 0n || value > 0xffff_ffffn) protocol(`Invalid native ${name}`); return integer(Number(value), name, 0, 0xffff_ffff); }

/** Values belong to one admitted process. Linux policy and native pointers stay in Rust/guest memory. */
export class NativeValues {
  readonly #handles: NativeHandles;
  readonly #references: NativeReferences;
  readonly #deferred = new Map<bigint, Deferred>();
  #promiseFactory = capturedPromiseFactory;
  readonly #prefix: bigint;
  readonly #environments = new Map<bigint, number>();
  #moduleVersion = 8;
  #currentEnvironment = 0n;
  readonly #wrapped = new WeakMap<object, Wrapped>();
  readonly #typeTags = new WeakMap<object, readonly [bigint, bigint]>();
  readonly #external = new WeakMap<object, Wrapped>();
  readonly #buffers: NativeBuffers;
  readonly #callbacks: NativeCallbacks;
  readonly #runtime: "node" | "bun";
  #async: NativeAsyncContexts | undefined;
  #nextDeferred = 0;
  #externalMemory = 0n;
  #pending: { readonly value: unknown } | undefined;
  readonly #escaped = new Map<bigint, Escaped>();
  constructor(readonly invoke: Invoke, readonly finalize: (callback: bigint) => void, releaseBuffer: (identity: number) => void = () => undefined, environment = 0,
    readonly fatalException: (error: unknown) => void = () => { throw new VMError("FEATURE_NOT_AVAILABLE", "Native fatal exception owner is unavailable"); },
    options: NativeValueOptions = { claim: () => undefined, retire: () => undefined }) {
    this.#prefix = BigInt(integer(environment, "native environment", 0, 0x7fff_ffff)) << 32n;
    this.#handles = new NativeHandles(this.#prefix);
    this.#references = new NativeReferences(this.#prefix);
    this.#buffers = new NativeBuffers(releaseBuffer);
    this.#callbacks = new NativeCallbacks(this.#prefix, { claim: options.claim, retire: options.retire, finalize });
    this.#runtime = options.runtime ?? "node";
  }
  registerEnvironment(identity: bigint, version: number): "node" | "bun" {
    if ((identity & 0xffff_ffff_0000_0000n) !== this.#prefix || identity !== (this.#prefix | BigInt(nativeMapSize(this.#environments) + 1)) || nativeMapSize(this.#environments) === 8 || ![8, 9, 10].includes(version)) protocol("Invalid native module environment registration");
    applyCollection(environmentSet, this.#environments, [identity, version]);
    return this.#runtime;
  }
  withEnvironment<T>(identity: bigint, action: () => T): T {
    const version = identity === 0n ? 8 : applyCollection(environmentGet, this.#environments, [identity]);
    if (version === undefined) protocol("Unknown or retired native module environment");
    const previous = this.#moduleVersion, previousEnvironment = this.#currentEnvironment; this.#moduleVersion = version; this.#currentEnvironment = identity;
    try { return action(); } finally { this.#moduleVersion = previous; this.#currentEnvironment = previousEnvironment; }
  }
  get moduleVersion(): number { return this.#moduleVersion; }
  bindAsyncContext(context: AsyncContext): void {
    if (this.#async !== undefined) protocol("Native async context is already bound");
    this.#async = new NativeAsyncContexts(this.#prefix, context);
    // Capture the installed process Promise before admitted code can replace it.
    const constructor = Promise;
    this.#promiseFactory = { constructor, create: constructor.withResolvers.bind(constructor) };
  }
  #selfResolutionError(promise: Promise<unknown>): Error | undefined {
    if (this.#runtime === "bun") return createNativeError("napi_create_type_error", undefined, "Cannot resolve a promise with itself", "bun");
    if (this.#promiseFactory.constructor === capturedPromiseFactory.constructor) return undefined;
    // shortcut: arbitrary inherited prototype chains need a qualified engine operation; inspect only this owned Promise and the captured prototype.
    const own = promiseDescriptor(promise, "constructor");
    const constructor: unknown = own === undefined && promisePrototypeOf(promise) === nativePromisePrototype
      ? promiseDescriptor(nativePromisePrototype, "constructor")?.value : own?.value;
    if (constructor === this.#promiseFactory.constructor) {
      return createNativeError("napi_create_type_error", undefined, "Chaining cycle detected for promise #<Promise>", "node");
    }
    return undefined;
  }
  #asyncContext(): NativeAsyncContexts {
    if (this.#async === undefined) protocol("Native async context is not bound");
    return this.#async;
  }
  createScope(identity: bigint): void { this.#handles.createTransport(identity); }
  retireScope(identity: bigint): void { try { this.#async?.retireTransport(identity); } finally { this.#handles.retireTransport(identity); } }
  withScope<T>(identity: bigint, action: () => T): T { return this.#handles.withTransport(identity, action); }
  add(value: unknown): bigint { return this.#handles.add(value); }
  get(handle: bigint): unknown { return this.#handles.get(handle); }
  throwPending(transport = this.#handles.currentTransport): void {
    const escaped = applyCollection(escapedGet, this.#escaped, [transport]);
    if (escaped !== undefined) { applyCollection(escapedDelete, this.#escaped, [transport]); throw escaped.value; }
    if (this.#pending !== undefined) { const error = this.#pending.value; this.#pending = undefined; throw error; }
  }
  #reference(value: unknown, count: number, finalizer = 0n): bigint {
    return this.#references.create(value, count, this.#runtime === "node" && this.#moduleVersion >= 10, this.#currentEnvironment, finalizer);
  }
  #function(callback: bigint, name: string, signature?: NativeClassSignature): (this: unknown, ...args: unknown[]) => unknown {
    this.#callbacks.validate(callback); const invoke = this.invoke, callbacks = this.#callbacks;
    const fn = function (this: unknown, ...args: unknown[]): unknown {
      const target: unknown = new.target;
      if (!callbacks.active(callback)) protocol("Native callback is retired");
      const receiver = this === undefined || this === null ? realmGlobal : nativeObject(this);
      if (signature !== undefined) {
        if (typeof classHas !== "function" || typeof classAdd !== "function") protocol("Native class identity intrinsics are unavailable");
        const classReceiver = ((typeof receiver === "object" && receiver !== null) || typeof receiver === "function") ? receiver : undefined;
        if (signature.kind === "method" && target === undefined && (classReceiver === undefined || applyClassIntrinsic(classHas, signature.receivers, [classReceiver]) !== true)) throw new ClassTypeError("Illegal invocation");
        if (signature.kind === "constructor" && target !== undefined && classReceiver !== undefined) applyClassIntrinsic(classAdd, signature.receivers, [classReceiver]);
      }
      return invoke(callback, receiver, target, args);
    };
    nativeDefineProperty(fn, "name", { value: name, configurable: true });
    this.#callbacks.add(fn, callback, "function", this.#currentEnvironment); return fn;
  }
  #validateFinalizer(callback: bigint): void { if (callback !== 0n) this.#callbacks.validate(callback); }
  #finalize(value: object, callback: bigint): void { if (callback !== 0n) this.#callbacks.add(value, callback, "finalizer", this.#currentEnvironment); }
  #forgetFinalizer(callback: bigint): void { this.#callbacks.cancel(callback); }
  finalizeResources(): void { this.#callbacks.finalize(); this.#buffers.dispose(); }
  dispose(): void {
    this.finalizeResources(); this.#callbacks.dispose();
    this.#async?.dispose(); this.#references.dispose(); applyCollection(clearCollection, this.#deferred, []); this.#handles.dispose(); applyCollection(clearCollection, this.#environments, []); applyCollection(clearCollection, this.#escaped, []);
  }
  dispatch(operation: string, args: readonly bigint[], bytes: Uint8Array): NativeResult {
    const ok = (...values: bigint[]): NativeResult => ({ status: 0, args: values.length === 0 ? [0n] : values, bytes: empty });
    const result = (value: unknown): NativeResult => ok(this.add(value));
    const at = (index: number): unknown => { const handle = args[index]; if (handle === undefined) protocol("Missing Node-API argument"); return this.get(handle); };
    const argumentsFrom = (start: 1 | 2 | 3): unknown[] => {
      const arrayLike = { __proto__: null, length: args.length - start };
      return arrayFrom(arrayLike, (_value, index) => at(start + index));
    };
    const number = (index: number) => scalar(args[index], "argument");
    const pending = (): void => { if (this.#pending !== undefined && requiresClearException(operation, this.#runtime)) throw new NapiFailure(10); };
    const shape = (count: number, payload = false): void => { if (args.length !== count || (!payload && bytes.byteLength !== 0)) protocol(`Invalid ${operation} argument shape`); pending(); };
    const refId = (index: number): bigint => { const id = args[index]; if (id === undefined) protocol("Missing native reference"); return id; };
    const name = () => decodeNativeString(bytes, "utf8");
    const conversionFailure = (value: unknown, status: NativeStatus, delivery: "pending" | "escaped"): never => {
      if (delivery === "pending") this.#pending = { value };
      else applyCollection(escapedSet, this.#escaped, [this.#handles.currentTransport, { value }]);
      throw new NapiFailure(status);
    };
    const boxed = (value: unknown, delivery: "pending" | "escaped" = "pending"): object => {
      let converted: unknown;
      try { converted = nativeObject(value); }
      catch (error) { return conversionFailure(error, 2, delivery); }
      return object(converted);
    };
    try {
      switch (operation) {
        case "napi_async_init": case "napi_create_async_work": case "napi_create_threadsafe_function": {
          shape(2); const resource = refId(0) === 0n ? undefined : boxed(at(0), "escaped"), input = at(1);
          let name: unknown;
          try { name = nativeString(input); }
          catch (error) { return conversionFailure(error, 3, "escaped"); }
          if (typeof name !== "string") protocol("Invalid native async resource name");
          return ok(this.#asyncContext().create(this.#currentEnvironment, resource, name, operation === "napi_async_init" ? "weak" : "strong"));
        }
        case "napi_async_destroy": shape(1); this.#asyncContext().destroy(this.#currentEnvironment, refId(0)); return ok();
        case "napi_open_callback_scope": shape(1); return ok(this.#asyncContext().open(this.#currentEnvironment, refId(0), this.#handles.currentTransport));
        case "napi_close_callback_scope": shape(1); this.#asyncContext().close(this.#currentEnvironment, refId(0), this.#handles.currentTransport); return ok();
        case "napi_make_callback": {
          if (args.length < 3 || args.length > 4096 || bytes.byteLength !== 0) protocol("Invalid native async callback arguments");
          pending(); const receiver = boxed(at(1)), callback = at(2);
          if (typeof callback !== "function") throw new NapiFailure(1);
          return result(this.#asyncContext().make(this.#currentEnvironment, refId(0), receiver, (): unknown => nativeApply(callback, receiver, argumentsFrom(3))));
        }
        case "napi_open_handle_scope": case "napi_open_escapable_handle_scope":
          shape(0); return ok(this.#handles.open(this.#currentEnvironment, operation === "napi_open_escapable_handle_scope"));
        case "napi_close_handle_scope": case "napi_close_escapable_handle_scope":
          shape(1); this.#handles.close(refId(0), this.#currentEnvironment, operation === "napi_close_escapable_handle_scope"); return ok();
        case "napi_escape_handle": shape(2); return ok(this.#handles.escape(refId(0), this.#currentEnvironment, refId(1)));
        case "napi_get_undefined": shape(0); return result(undefined);
        case "napi_get_null": shape(0); return result(null);
        case "napi_get_global": shape(0); return result(realmGlobal);
        // shortcut: ordinary-object prototypes are qualified; qualify V8 proxy behavior before admitting proxy-aware addons.
        case "napi_get_prototype": shape(1); return result(nativePrototypeOf(boxed(at(0))));
        case "napi_has_own_property": shape(2); return ok(nativeHasOwn(boxed(at(0)), key(at(1))) ? 1n : 0n);
        case "napi_strict_equals": shape(2); return ok(at(0) === at(1) ? 1n : 0n);
        case "napi_create_object": shape(0); return result({});
        case "napi_create_array": shape(0); return result([]);
        case "napi_create_bigint_int64": shape(1); return result(nativeSignedInteger(refId(0)));
        case "napi_create_bigint_uint64": shape(1); return result(refId(0));
        case "napi_get_value_bigint_int64": case "napi_get_value_bigint_uint64":
          {
            shape(1);
            const converted = nativeBigInt64(at(0), operation === "napi_get_value_bigint_int64");
            // Pinned Bun writes uint64 bits before checking the existing exception.
            if (this.#runtime === "bun" && operation === "napi_get_value_bigint_uint64" && this.#pending !== undefined) return { status: 10, args: [converted[0]], bytes: empty };
            return ok(...converted);
          }
        case "napi_create_bigint_words": shape(1, true); return result(nativeBigIntFromWords(number(0), bytes));
        case "napi_get_value_bigint_words": shape(2); return { status: 0, ...nativeBigIntWords(at(0), number(1)) };
        case "napi_create_date": shape(1); return result(nativeDate(refId(0)));
        case "napi_get_date_value": shape(1); return ok(nativeDoubleBits(nativeDateTime(at(0))));
        case "napi_is_date": shape(1); return ok(nativeIsDate(at(0)) ? 1n : 0n);
        case "napi_create_symbol": case "node_api_symbol_for": {
          shape(1); const description = operation === "napi_create_symbol" && refId(0) === 0n ? undefined : at(0);
          if (description === undefined && operation === "napi_create_symbol" && refId(0) === 0n) return result(createSymbol());
          if (typeof description !== "string") throw new NapiFailure(3);
          return result(operation === "napi_create_symbol" ? createSymbol(description) : registeredSymbol(description));
        }
        case "napi_create_int32": shape(1); return result(Number(nativeSignedInteger(args[0] ?? 0n, 32)));
        case "napi_create_uint32": shape(1); return result(number(0));
        case "napi_create_int64": shape(1); return result(Number(nativeSignedInteger(args[0] ?? 0n)));
        case "napi_create_double": {
          shape(1); return result(nativeDouble(args[0] ?? 0n));
        }
        case "napi_get_value_double": {
          shape(1); const input = at(0); if (typeof input !== "number") throw new NapiFailure(6);
          return ok(nativeDoubleBits(input));
        }
        case "napi_get_value_uint32": {
          shape(1); const input = at(0); if (typeof input !== "number") throw new NapiFailure(6); return ok(BigInt(input >>> 0));
        }
        case "napi_get_value_int32": {
          shape(1); const input = at(0); if (typeof input !== "number") throw new NapiFailure(6);
          return ok(nativeUnsignedInteger(BigInt(input | 0)));
        }
        case "napi_get_value_int64": {
          shape(1); const input = at(0); if (typeof input !== "number") throw new NapiFailure(6);
          const integer = !Number.isFinite(input) ? 0n : input >= 2 ** 63 ? (1n << 63n) - 1n : input <= -(2 ** 63) ? -(1n << 63n) : BigInt(Math.trunc(input));
          return ok(nativeUnsignedInteger(integer));
        }
        case "napi_is_array": shape(1); return ok(Array.isArray(at(0)) ? 1n : 0n);
        case "napi_get_array_length": { shape(1); const input = at(0); if (!Array.isArray(input)) throw new NapiFailure(8); return ok(BigInt(input.length)); }
        case "napi_get_element": shape(2); return result(nativeGetProperty(boxed(at(0)), `${number(1)}`));
        case "napi_has_element": shape(2); return ok(nativeHasProperty(boxed(at(0)), `${number(1)}`) ? 1n : 0n);
        case "napi_delete_element": shape(2); return ok(nativeDeleteProperty(boxed(at(0)), `${number(1)}`) ? 1n : 0n);
        case "napi_delete_property": {
          shape(2); const deleted: unknown = nativeDeleteProperty(boxed(at(0)), at(1)); return ok(deleted === true ? 1n : 0n);
        }
        case "napi_object_freeze": shape(1); nativeFreeze(boxed(at(0))); return ok();
        case "napi_object_seal": shape(1); nativeSeal(boxed(at(0))); return ok();
        case "napi_coerce_to_bool": shape(1); return result(nativeBoolean(at(0)));
        case "napi_coerce_to_number": {
          shape(1); const input = at(0); let converted: unknown;
          try { converted = nativeNumber(input); } catch (error) { return conversionFailure(error, 6, "pending"); }
          return result(converted);
        }
        case "napi_instanceof": {
          shape(2); const input = at(0), constructor = boxed(at(1));
          if (typeof constructor !== "function") {
            this.#pending = { value: createNativeError("napi_create_type_error", "ERR_NAPI_CONS_FUNCTION", "Constructor must be a function", this.#runtime) }; throw new NapiFailure(5);
          }
          let matched: boolean;
          try { matched = nativeInstanceOf(input, constructor); } catch (error) { this.#pending = { value: error }; throw new NapiFailure(9); }
          return ok(matched ? 1n : 0n);
        }
        case "napi_get_property_names": {
          shape(1); const names = []; for (const name in object(at(0))) names.push(name); return result(names);
        }
        case "napi_new_instance": {
          if (args.length < 1 || args.length > 4096 || bytes.byteLength !== 0) protocol("Invalid native constructor arguments");
          pending();
          const constructor = at(0); if (typeof constructor !== "function") throw new NapiFailure(5);
          return result(nativeConstruct(constructor, argumentsFrom(1)));
        }
        case "napi_create_array_with_length": {
          shape(1); const length = Number(nativeSignedInteger(args[0] ?? 0n, 32));
          return result(new NativeArray<unknown>(length > 0 ? length : 0));
        }
        case "napi_get_boolean": shape(1); if (number(0) > 1) throw new NapiFailure(1); return result(number(0) === 1);
        case "napi_create_string_utf8": case "node_api_create_property_key_utf8": shape(0, true); return result(decodeNativeString(bytes, "utf8"));
        case "napi_create_string_latin1": case "node_api_create_property_key_latin1": case "node_api_create_external_string_latin1": shape(0, true); return result(decodeNativeString(bytes, "latin1"));
        case "napi_create_string_utf16": case "node_api_create_property_key_utf16": case "node_api_create_external_string_utf16": shape(0, true); return result(decodeNativeString(bytes, "utf16"));
        case "napi_get_value_string_utf8": {
          shape(2); const query = refId(1); if (query > 1n) protocol("Invalid native UTF8 query flag");
          return { status: 0, ...readNativeUtf8(at(0), query === 1n, this.#runtime) };
        }
        case "napi_get_value_string_latin1": shape(1); return { status: 0, args: [], bytes: encodeNativeString(at(0), "latin1") };
        case "napi_get_value_string_utf16": shape(1); return { status: 0, args: [], bytes: encodeNativeString(at(0), "utf16") };
        case "napi_coerce_to_string": {
          shape(1); const input = at(0); let converted: unknown;
          try { converted = nativeString(input); } catch (error) { return conversionFailure(error, 3, "pending"); }
          return result(converted);
        }
        case "napi_coerce_to_object": shape(1); return result(boxed(at(0)));
        case "napi_typeof": {
          shape(1); const value = at(0);
          if (value === null) return ok(1n);
          if ((typeof value === "object" || typeof value === "function") && applyCollection(wrappedHas, this.#external, [value])) return ok(8n);
          const types: Readonly<Record<string, bigint>> = { undefined: 0n, boolean: 2n, number: 3n, string: 4n, symbol: 5n, object: 6n, function: 7n, bigint: 9n };
          const type = types[typeof value]; if (type === undefined) protocol("Unknown JavaScript value type"); return ok(type);
        }
        case "napi_get_named_property": shape(1, true); return result(nativeGetProperty(boxed(at(0)), name()));
        case "napi_has_named_property": shape(1, true); return ok(nativeHasProperty(boxed(at(0)), name()) ? 1n : 0n);
        case "napi_has_property": {
          shape(2); const found: unknown = nativeHasProperty(boxed(at(0)), at(1));
          if (typeof found !== "boolean") protocol("Invalid native property result"); return ok(found ? 1n : 0n);
        }
        case "napi_set_named_property": shape(2, true); nativeSetProperty(boxed(at(0)), name(), at(1)); return ok();
        case "napi_get_property": shape(2); return result(nativeGetProperty(boxed(at(0)), at(1)));
        case "napi_set_property": shape(3); nativeSetProperty(boxed(at(0)), at(1), at(2)); return ok();
        case "napi_set_element": shape(3); nativeSetProperty(boxed(at(0)), `${number(1)}`, at(2)); return ok();
        case "napi_create_function": shape(1, true); return result(this.#function(refId(0), name()));
        case "napi_call_function": {
          if (args.length < 2 || args.length > 4096 || bytes.byteLength !== 0) protocol("Invalid native callback argument shape");
          pending();
          const fn = at(1); if (typeof fn !== "function") throw new NapiFailure(5);
          return result(nativeApply(fn, at(0), argumentsFrom(2)));
        }
        case "napi_define_class":
        case "napi_define_properties": {
          if (args.length < 2 || args.length > 4096 || args.length !== 2 + number(1) * 6 || (operation === "napi_define_properties" && bytes.byteLength !== 0)) protocol("Invalid native property argument shape");
          pending();
          const callbacks = operation === "napi_define_class" ? [refId(0)] : [];
          for (let index = 0; index < number(1); index++) {
            const offset = 2 + index * 6;
            at(offset); number(offset + 5);
            if (refId(offset + 4) !== 0n) at(offset + 4);
            for (let kind = 1; kind <= 3; kind++) {
              const callback = refId(offset + kind);
              if (callback !== 0n) callbacks.push(callback);
            }
          }
          this.#callbacks.validateAll(callbacks);
          const receivers = operation === "napi_define_class" && this.#runtime === "node" ? new ClassReceivers<object>() : undefined;
          const target = operation === "napi_define_class" ? this.#function(refId(0), name(), receivers === undefined ? undefined : { kind: "constructor", receivers }) : object(at(0));
          for (let index = 0; index < number(1); index++) {
            const offset = 2 + index * 6, method = refId(offset + 1), getter = refId(offset + 2), setter = refId(offset + 3), attributes = number(offset + 5);
            const property = key(at(offset));
            const destination = operation === "napi_define_class" && (attributes & 1024) === 0 ? object(nativeGetProperty(target, "prototype")) : target;
            const descriptor: PropertyDescriptor = { enumerable: (attributes & 2) !== 0, configurable: (attributes & 4) !== 0 };
            if (getter !== 0n || setter !== 0n) {
              if (getter !== 0n) descriptor.get = this.#function(getter, "");
              if (setter !== 0n) descriptor.set = this.#function(setter, "");
            } else { descriptor.writable = (attributes & 1) !== 0; descriptor.value = method !== 0n ? this.#function(method, operation === "napi_define_class" && (attributes & 1024) === 0 && typeof property === "string" ? property : "", receivers !== undefined && (attributes & 1024) === 0 ? { kind: "method", receivers } : undefined) : args[offset + 4] === 0n ? undefined : at(offset + 4); }
            nativeDefineProperty(destination, property, descriptor);
          }
          return result(target);
        }
        case "napi_create_reference": shape(2); return ok(this.#reference(at(0), number(1)));
        case "napi_delete_reference": shape(1); this.#forgetFinalizer(this.#references.delete(refId(0), this.#currentEnvironment)); return ok();
        case "napi_reference_ref": shape(1); return ok(BigInt(this.#references.ref(refId(0), this.#currentEnvironment)));
        case "napi_reference_unref": shape(1); return ok(BigInt(this.#references.unref(refId(0), this.#currentEnvironment)));
        case "napi_get_reference_value": { shape(1); const held = this.#references.get(refId(0), this.#currentEnvironment); return held === undefined ? ok(0n) : result(held.value); }
        case "napi_wrap": {
          shape(4); const target = object(at(0)); if (applyCollection(wrappedHas, this.#wrapped, [target])) throw new NapiFailure(1);
          const pointer = args[1]; if (pointer === undefined) protocol("Missing native pointer");
          const finalizer = refId(2), requested = number(3); if (requested > 1) protocol("Invalid native wrap reference request");
          if (requested !== 0 && finalizer === 0n && this.#runtime === "node") throw new NapiFailure(1);
          this.#validateFinalizer(finalizer);
          const reference = requested === 0 ? 0n : this.#reference(target, 0, finalizer);
          applyCollection(wrappedSet, this.#wrapped, [target, { pointer, finalizer }]); this.#finalize(target, finalizer); return ok(reference);
        }
        case "napi_add_finalizer": {
          shape(3); const input = at(0); if ((typeof input !== "object" || input === null) && typeof input !== "function") throw new NapiFailure(1);
          const finalizer = refId(1), requested = number(2); if (requested > 1) protocol("Invalid native finalizer reference request");
          if (finalizer === 0n) throw new NapiFailure(1);
          this.#validateFinalizer(finalizer);
          const reference = requested === 0 ? 0n : this.#reference(input, 0, finalizer); this.#finalize(input, finalizer); return ok(reference);
        }
        case "napi_type_tag_object": case "napi_check_object_type_tag": {
          shape(3); const target = boxed(at(0)), lower = refId(1), upper = refId(2), previous = applyCollection(tagGet, this.#typeTags, [target]);
          if (operation === "napi_check_object_type_tag") return ok(previous?.[0] === lower && previous[1] === upper ? 1n : 0n);
          if (previous !== undefined) throw new NapiFailure(1); applyCollection(tagSet, this.#typeTags, [target, [lower, upper]]); return ok();
        }
        case "napi_unwrap":
        case "napi_remove_wrap": {
          shape(1); const target = object(at(0)), wrapped = applyCollection(wrappedGet, this.#wrapped, [target]); if (wrapped === undefined) throw new NapiFailure(1);
          if (operation === "napi_remove_wrap") { applyCollection(wrappedDelete, this.#wrapped, [target]); this.#forgetFinalizer(wrapped.finalizer); }
          return ok(wrapped.pointer);
        }
        case "napi_create_external": {
          shape(2); const target: unknown = nativeCreateObject(null);
          const external = object(target), pointer = args[0]; if (pointer === undefined) protocol("Missing external pointer");
          const finalizer = refId(1); applyCollection(wrappedSet, this.#external, [external, { pointer, finalizer }]); this.#finalize(external, finalizer); return result(external);
        }
        case "napi_get_value_external": { shape(1); const external = applyCollection(wrappedGet, this.#external, [object(at(0))]); if (external === undefined) throw new NapiFailure(1); return ok(external.pointer); }
        case "napi_is_error": shape(1); return ok(nativeIsError(at(0), this.#runtime) ? 1n : 0n);
        case "napi_is_buffer": shape(1); return ok(at(0) instanceof Uint8Array ? 1n : 0n);
        case "napi_is_arraybuffer": shape(1); return ok(nativeIsArrayBuffer(at(0)) ? 1n : 0n);
        case "napi_is_dataview": shape(1); return ok(nativeIsDataView(at(0)) ? 1n : 0n);
        case "napi_is_detached_arraybuffer": shape(1); return ok(nativeIsDetachedArrayBuffer(at(0)) ? 1n : 0n);
        case "napi_is_typedarray": shape(1); return ok(nativeIsTypedArray(at(0)) ? 1n : 0n);
        case "napi_is_promise": shape(1); return ok(nativeIsPromise(at(0)) ? 1n : 0n);
        case "napi_create_buffer": {
          shape(1); const buffer = this.#buffers.create(number(0)); return ok(this.add(buffer.value), BigInt(buffer.identity));
        }
        case "napi_create_buffer_copy":
        case "napi_create_external_buffer": {
          shape(0, true); const buffer = this.#buffers.create(bytes.length, bytes); return ok(this.add(buffer.value), BigInt(buffer.identity));
        }
        case "buffer-update": shape(1, true); this.#buffers.update(number(0), bytes); return ok();
        case "napi_get_typedarray_info":
        case "napi_get_buffer_info": {
          shape(1); const value = at(0);
          if (!ArrayBuffer.isView(value) || value instanceof DataView || (operation === "napi_get_buffer_info" && !(value instanceof Uint8Array))) throw new NapiFailure(1);
          const buffer = this.#buffers.inspect(value);
          return { status: 0, args: [BigInt(buffer.identity), BigInt(buffer.type), BigInt(buffer.length), BigInt(buffer.offset), this.add(buffer.buffer)], bytes: buffer.bytes };
        }
        case "napi_get_value_bool": shape(1); if (typeof at(0) !== "boolean") throw new NapiFailure(7); return ok(at(0) === true ? 1n : 0n);
        case "napi_create_promise": {
          shape(0); if (nativeMapSize(this.#deferred) >= 128 || this.#nextDeferred === 0xffff_ffff) protocol("Native promise limit"); const id = this.#prefix | BigInt(++this.#nextDeferred);
          const deferred = this.#promiseFactory.create<unknown>(); applyCollection(deferredSet, this.#deferred, [id, deferred]);
          return ok(id, this.add(deferred.promise));
        }
        case "napi_resolve_deferred":
        case "napi_reject_deferred": {
          shape(2); const id = refId(0), deferred = applyCollection(deferredGet, this.#deferred, [id]); if (deferred === undefined) throw new NapiFailure(1);
          const value = at(1); applyCollection(deferredDelete, this.#deferred, [id]);
          const cycle = operation === "napi_resolve_deferred" && value === deferred.promise ? this.#selfResolutionError(deferred.promise) : undefined;
          if (cycle !== undefined) deferred.reject(cycle);
          else if (operation === "napi_resolve_deferred") deferred.resolve(value);
          else deferred.reject(value);
          return ok();
        }
        case "napi_create_error": case "napi_create_type_error": case "napi_create_range_error": case "node_api_create_syntax_error": {
          shape(2); const code = args[0];
          if (code !== 0n && typeof at(0) !== "string") throw new NapiFailure(3);
          return result(createNativeError(operation, code === 0n ? undefined : at(0), at(1), this.#runtime));
        }
        case "napi_throw_error": case "napi_throw_type_error": case "napi_throw_range_error": case "node_api_throw_syntax_error":
          shape(2, true); if (number(1) > 1) protocol("Invalid native error message presence"); if (number(1) === 0) throw new NapiFailure(1);
          this.#pending = { value: thrownNativeError(operation, number(0), bytes, this.#runtime) }; return ok();
        case "napi_fatal_exception": shape(1); this.fatalException(at(0)); return ok();
        case "napi_throw": shape(1); this.#pending = { value: at(0) }; return ok();
        case "napi_is_exception_pending": shape(0); return ok(this.#pending === undefined ? 0n : 1n);
        case "napi_get_and_clear_last_exception": { shape(0); const value = this.#pending?.value; this.#pending = undefined; return result(value); }
        case "napi_adjust_external_memory": { shape(1); const change = args[0]; if (change === undefined) protocol("Missing external memory delta"); this.#externalMemory = nativeSignedInteger(this.#externalMemory + nativeSignedInteger(change)); return ok(nativeUnsignedInteger(this.#externalMemory)); }
        default: throw new VMError("FEATURE_NOT_AVAILABLE", `Unsupported Node-API operation: ${operation}`, { lateFailure: "unsupported-node-api", subject: operation });
      }
    } catch (error) {
      if (NativeErrorCodeFailure.is(error)) {
        if (requiresClearException(operation, this.#runtime)) this.#pending = { value: error.exception };
        return { status: operation === "napi_instanceof" ? 5 : 9, args: [], bytes: empty };
      }
      if (NapiFailure.is(error)) return { status: error.status, args: [], bytes: empty };
      if (isVMError(error)) throw error;
      this.#pending = { value: error }; return { status: 10, args: [], bytes: empty };
    }
  }
}
