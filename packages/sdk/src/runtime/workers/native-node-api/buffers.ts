import { Buffer } from "buffer";
import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import { protocol } from "../../js-process/codec.js";
import { nativeMapSize } from "./collection-size.js";
import { nativeTypedArrayKind, nativeTypedArrayTypes } from "./arraybuffers.js";

const MAX_BYTES = 128 * 1024 * 1024;
interface Backing { readonly weak: WeakRef<ArrayBuffer>; readonly token: object; readonly length: number; readonly original: Uint8Array | undefined }
const backings = new Map<number, Backing>(), apply = Reflect.apply;
const backingGet = Reflect.get(backings, "get"), backingSet = Reflect.get(backings, "set"), backingDelete = Reflect.get(backings, "delete"), backingKeys = Reflect.get(backings, "keys");
const backingNext = Reflect.get(apply(backingKeys, backings, []), "next");
const identities = new WeakMap<ArrayBuffer, number>(), identityGet = Reflect.get(identities, "get"), identitySet = Reflect.get(identities, "set");
const NativeFinalizationRegistry = FinalizationRegistry, NativeWeakRef = WeakRef;
const registry = new NativeFinalizationRegistry<number>(() => undefined), weak = new NativeWeakRef(new ArrayBuffer(0));
const register = Reflect.get(registry, "register"), unregister = Reflect.get(registry, "unregister"), deref = Reflect.get(weak, "deref");
const Bytes = Uint8Array, Words = BigUint64Array;

/** Whether `buffer` still holds `original`'s bytes: eight at a time, by index, so application code cannot intercept it. */
function unchanged(buffer: ArrayBuffer, original: Uint8Array): boolean {
  const length = original.byteLength, words = length >>> 3, current = new Bytes(buffer);
  if (words !== 0 && original.byteOffset % 8 === 0) {
    const left = new Words(buffer, 0, words), right = new Words(original.buffer, original.byteOffset, words);
    for (let index = 0; index < words; index++) if (left[index] !== right[index]) return false;
  } else for (let index = 0; index < words * 8; index++) if (current[index] !== original[index]) return false;
  for (let index = words * 8; index < length; index++) if (current[index] !== original[index]) return false;
  return true;
}

/** Copied native memory is scoped to its JS backing buffer, not the process lifetime. */
export class NativeBuffers {
  readonly #identities = new WeakMap<ArrayBuffer, number>();
  readonly #backings = new Map<number, Backing>();
  readonly #registry: FinalizationRegistry<number>;
  #next = 0;
  #bytes = 0;
  /**
   * `twoWay` (operation set 2): every backing keeps the bytes both sides last agreed on, and either side may change it.
   * `budget`: the bytes this launch may share at once, which Rust sets from the launch's admission basis (OXCR 21).
   */
  constructor(readonly release: (identity: number) => void, readonly twoWay = false, readonly budget = MAX_BYTES) {
    this.#registry = new NativeFinalizationRegistry(identity => { this.#retire(identity); });
  }
  #retire(identity: number): void {
    const backing = apply(backingGet, this.#backings, [identity]); if (backing === undefined) return;
    apply(backingDelete, this.#backings, [identity]); this.#bytes -= backing.length; apply(unregister, this.#registry, [backing.token]); this.release(identity);
  }
  /** The identity native code knows this backing store by; its bytes are handed over once and synced from then on. */
  #identity(buffer: ArrayBuffer, owned: boolean): number {
    const known = apply(identityGet, this.#identities, [buffer]);
    if (known !== undefined) {
      // Native code holds a pointer to the bytes it was given; a detached or resized store has no such bytes any more.
      if (apply(backingGet, this.#backings, [known])?.length !== buffer.byteLength) throw new VMError("FEATURE_NOT_AVAILABLE", "A detached or resized buffer that native code holds is unsupported", { lateFailure: "unsupported-node-api", subject: "detached-native-buffer" });
      return known;
    }
    // Every shared byte is compared at each handover; past the budget the program belongs in Linux, and says so once.
    if (this.budget < MAX_BYTES && this.#bytes + buffer.byteLength > this.budget) throw new VMError("FEATURE_NOT_AVAILABLE", "The add-on shares more memory with JavaScript than the fast path's budget", { lateFailure: "shared-buffer-budget", subject: `${String(this.#bytes + buffer.byteLength)} of ${String(this.budget)} bytes` });
    integer(buffer.byteLength, "native backing length", 0, MAX_BYTES);
    if (nativeMapSize(this.#backings) >= 4096 || this.#bytes + buffer.byteLength > MAX_BYTES || this.#next === 0xffff_ffff) protocol("Native buffer resource limit");
    const identity = ++this.#next, token = {};
    apply(backingSet, this.#backings, [identity, { weak: new NativeWeakRef(buffer), token, length: buffer.byteLength, original: owned || this.twoWay ? new Uint8Array(buffer).slice() : undefined }]);
    apply(identitySet, this.#identities, [buffer, identity]); this.#bytes += buffer.byteLength; apply(register, this.#registry, [buffer, identity, token]);
    return identity;
  }
  inspect(value: ArrayBufferView, owned = false) {
    const buffer = value.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new VMError("FEATURE_NOT_AVAILABLE", "Concurrent shared native buffers are unsupported");
    const type = nativeTypedArrayTypes.findIndex(([, , target]) => typeof target === "function" && value instanceof target);
    const size = nativeTypedArrayKind(type, "napi_get_typedarray_info")?.[1];
    if (size === undefined) protocol("Native buffer is not a typed array");
    return { identity: this.#identity(buffer, owned), type, length: value.byteLength / size, offset: value.byteOffset, buffer, bytes: new Uint8Array(buffer) };
  }
  /** A whole ArrayBuffer or a DataView's window, in the answer shape of `inspect`: bytes (Uint8Array, 1) at an offset. */
  inspectBytes(buffer: ArrayBuffer, offset = 0, length = buffer.byteLength) {
    return { identity: this.#identity(buffer, false), type: 1, length, offset, buffer, bytes: new Uint8Array(buffer) };
  }
  create(length: number, bytes?: Uint8Array) {
    integer(length, "native buffer length", 0, 0xffff_ffff);
    if (this.budget < MAX_BYTES && this.#bytes + length > this.budget) throw new VMError("FEATURE_NOT_AVAILABLE", "The add-on shares more memory with JavaScript than the fast path's budget", { lateFailure: "shared-buffer-budget", subject: `${String(this.#bytes + length)} of ${String(this.budget)} bytes` });
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
    if (!unchanged(buffer, backing.original)) protocol("A concurrent JS/native buffer mutation is unsupported");
    current.set(bytes); backing.original.set(bytes);
  }
  /**
   * Hands native code every buffer JavaScript changed since the last handover (operation set 2). A backing whose
   * ArrayBuffer was detached or collected has nothing to hand over.
   */
  changes(push: (identity: number, bytes: Uint8Array) => void): void {
    if (!this.twoWay) return;
    const iterator = apply(backingKeys, this.#backings, []);
    for (let step = apply(backingNext, iterator, []); step.done !== true; step = apply(backingNext, iterator, [])) {
      const backing = apply(backingGet, this.#backings, [step.value]), buffer = backing === undefined ? undefined : apply(deref, backing.weak, []);
      if (backing?.original === undefined || buffer === undefined || buffer.byteLength !== backing.length || unchanged(buffer, backing.original)) continue;
      const current = new Bytes(buffer); backing.original.set(current); push(step.value, current);
    }
  }
  dispose(): void {
    const iterator = apply(backingKeys, this.#backings, []);
    for (let step = apply(backingNext, iterator, []); step.done !== true; step = apply(backingNext, iterator, [])) this.#retire(step.value);
  }
}
