import { Buffer } from "buffer";
import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import { protocol } from "../../js-process/codec.js";
import { nativeMapSize } from "./collection-size.js";

const MAX_BYTES = 128 * 1024 * 1024;
const types = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
interface Backing { readonly weak: WeakRef<ArrayBuffer>; readonly token: object; readonly length: number; readonly original: Uint8Array | undefined }
const backings = new Map<number, Backing>(), apply = Reflect.apply;
const backingGet = Reflect.get(backings, "get"), backingSet = Reflect.get(backings, "set"), backingDelete = Reflect.get(backings, "delete"), backingKeys = Reflect.get(backings, "keys");
const backingNext = Reflect.get(apply(backingKeys, backings, []), "next");
const identities = new WeakMap<ArrayBuffer, number>(), identityGet = Reflect.get(identities, "get"), identitySet = Reflect.get(identities, "set");
const NativeFinalizationRegistry = FinalizationRegistry, NativeWeakRef = WeakRef;
const registry = new NativeFinalizationRegistry<number>(() => undefined), weak = new NativeWeakRef(new ArrayBuffer(0));
const register = Reflect.get(registry, "register"), unregister = Reflect.get(registry, "unregister"), deref = Reflect.get(weak, "deref");

/** Copied native memory is scoped to its JS backing buffer, not the process lifetime. */
export class NativeBuffers {
  readonly #identities = new WeakMap<ArrayBuffer, number>();
  readonly #backings = new Map<number, Backing>();
  readonly #registry: FinalizationRegistry<number>;
  #next = 0;
  #bytes = 0;
  constructor(readonly release: (identity: number) => void) {
    this.#registry = new NativeFinalizationRegistry(identity => { this.#retire(identity); });
  }
  #retire(identity: number): void {
    const backing = apply(backingGet, this.#backings, [identity]); if (backing === undefined) return;
    apply(backingDelete, this.#backings, [identity]); this.#bytes -= backing.length; apply(unregister, this.#registry, [backing.token]); this.release(identity);
  }
  inspect(value: ArrayBufferView, owned = false) {
    const buffer = value.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new VMError("FEATURE_NOT_AVAILABLE", "Concurrent shared native buffers are unsupported");
    let identity = apply(identityGet, this.#identities, [buffer]);
    if (identity === undefined) {
      integer(buffer.byteLength, "native backing length", 0, MAX_BYTES);
      if (nativeMapSize(this.#backings) >= 4096 || this.#bytes + buffer.byteLength > MAX_BYTES || this.#next === 0xffff_ffff) protocol("Native buffer resource limit");
      identity = ++this.#next; const token = {};
      apply(backingSet, this.#backings, [identity, { weak: new NativeWeakRef(buffer), token, length: buffer.byteLength, original: owned ? new Uint8Array(buffer).slice() : undefined }]);
      apply(identitySet, this.#identities, [buffer, identity]); this.#bytes += buffer.byteLength; apply(register, this.#registry, [buffer, identity, token]);
    }
    const type = types.findIndex(constructor => value instanceof constructor);
    const size = types[type]?.BYTES_PER_ELEMENT;
    if (size === undefined) protocol("Native buffer is not a typed array");
    return { identity, type, length: value.byteLength / size, offset: value.byteOffset, buffer, bytes: new Uint8Array(buffer) };
  }
  create(length: number, bytes?: Uint8Array) {
    integer(length, "native buffer length", 0, MAX_BYTES);
    const buffer = Buffer.alloc(length); if (bytes !== undefined) buffer.set(bytes);
    return { value: buffer, ...this.inspect(buffer, true) };
  }
  update(identity: number, bytes: Uint8Array): void {
    const backing = apply(backingGet, this.#backings, [identity]), buffer = backing === undefined ? undefined : apply(deref, backing.weak, []);
    if (backing === undefined || buffer === undefined) protocol("Stale native buffer identity");
    if (backing.original === undefined) protocol("A read-only native input buffer cannot be updated");
    if (bytes.byteLength !== backing.length || buffer.byteLength !== backing.length) protocol("Native buffer update length mismatch");
    const current = new Uint8Array(buffer);
    if (!current.every((value, index) => value === backing.original?.[index])) protocol("A concurrent JS/native buffer mutation is unsupported");
    current.set(bytes); backing.original.set(bytes);
  }
  dispose(): void {
    const iterator = apply(backingKeys, this.#backings, []);
    for (let step = apply(backingNext, iterator, []); step.done !== true; step = apply(backingNext, iterator, [])) this.#retire(step.value);
  }
}
