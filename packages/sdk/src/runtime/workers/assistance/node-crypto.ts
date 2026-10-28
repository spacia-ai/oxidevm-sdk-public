import type { ProcessScheduler } from "./process-scheduler.js";
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { equalBytes } from '@noble/curves/utils.js';
import { Buffer } from 'buffer/';
import scheduling from 'process/';
import { Transform } from 'readable-stream';
import { VMError } from '../../errors.ts';

type DigestState = { update(bytes: Uint8Array): unknown; digest(): Uint8Array; clone(): DigestState };
const algorithms = { md5, ripemd160, sha1, sha224, sha256, sha384, sha512, 'sha512-224': sha512_224, 'sha512-256': sha512_256 };
function knownAlgorithm(value: string): value is keyof typeof algorithms { return Object.hasOwn(algorithms, value); }
function algorithm(value: unknown, api: string) {
  if (typeof value !== 'string') throw new TypeError(`${api} algorithm must be a string`);
  const name = value.toLowerCase().replace(/^sha-(1|224|256|384|512)$/u, 'sha$1');
  if (!knownAlgorithm(name)) throw new VMError('FEATURE_NOT_AVAILABLE', `${api} algorithm is unsupported`, { api, algorithm: value });
  return algorithms[name];
}
function bytes(value: unknown, encoding?: unknown): Uint8Array {
  if (typeof value === 'string') {
    const selected = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
    return Buffer.from(value, selected);
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Crypto input must be a string, Buffer, TypedArray or DataView');
}
function output(value: Uint8Array, encoding: unknown): Buffer | string {
  const result = Buffer.from(value);
  if (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)) return result;
  return result.toString(encoding);
}
function finalized(): Error {
  return Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
}

class Digest extends Transform {
  #state: DigestState | undefined;
  readonly #hmac: boolean;
  constructor(state: DigestState, isHmac = false) {
    super({
      transform: (chunk, encoding, done) => {
        try { this.update(chunk, encoding); done(); }
        catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
      },
      flush: done => {
        try { this.push(this.digest()); done(); }
        catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
      },
    });
    this.#state = state;
    this.#hmac = isHmac;
  }
  protected live(): DigestState { if (this.#state === undefined) throw finalized(); return this.#state; }
  update(value: unknown, encoding?: unknown): this { this.live().update(bytes(value, encoding)); return this; }
  digest(): Buffer;
  digest(encoding: unknown): Buffer | string;
  digest(encoding?: unknown): Buffer | string {
    if (this.#state === undefined && this.#hmac) return output(new Uint8Array(), encoding);
    const state = this.live();
    this.#state = undefined;
    return output(state.digest(), encoding);
  }
}
class Hash extends Digest {
  copy(): Hash { return new Hash(this.live().clone()); }
}
function createHash(name: unknown): Hash { return new Hash(algorithm(name, 'crypto.createHash').create()); }
function hash(name: unknown, input: unknown, encoding: unknown = 'hex'): Buffer | string {
  if (encoding !== 'buffer' && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding))) throw new VMError('FEATURE_NOT_AVAILABLE', 'crypto.hash output encoding is unsupported');
  return output(algorithm(name, 'crypto.hash')(bytes(input)), encoding);
}
function timingSafeEqual(left: unknown, right: unknown): boolean {
  const view = (input: unknown): Uint8Array => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw Object.assign(new TypeError('crypto.timingSafeEqual requires ArrayBuffer, Buffer, TypedArray or DataView inputs'), { code: 'ERR_INVALID_ARG_TYPE' });
  };
  const a = view(left), b = view(right);
  if (a.length !== b.length) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' });
  // Noble scans every byte; browser JIT/GC cannot guarantee wall-clock constant time.
  return equalBytes(a, b);
}
function createHmac(name: unknown, key: unknown): Digest { return new Digest(hmac.create(algorithm(name, 'crypto.createHmac'), bytes(key)), true); }
function boundedNumber(value: unknown, name: string, minimum: number, integral: boolean): number {
  if (typeof value !== 'number') throw Object.assign(new TypeError(`${name} must be a number`), { code: 'ERR_INVALID_ARG_TYPE' });
  if (!Number.isFinite(value) || value < minimum || value > 0x7fffffff || (integral && !Number.isInteger(value))) throw Object.assign(new RangeError(`${name} out of range`), { code: 'ERR_OUT_OF_RANGE' });
  return Math.trunc(value);
}
function pbkdf2Sync(password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown): Buffer {
  const count = boundedNumber(iterations, 'crypto.pbkdf2Sync iterations', 1, true);
  const length = boundedNumber(keylen, 'crypto.pbkdf2Sync keylen', 0, true);
  const selected = algorithm(digest, 'crypto.pbkdf2Sync');
  const passwordBytes = bytes(password); const saltBytes = bytes(salt);
  if (length === 0) throw new Error('crypto.pbkdf2Sync key derivation failed');
  return Buffer.from(pbkdf2(selected, passwordBytes, saltBytes, { c: count, dkLen: length }));
}
// Preserve the browser entropy provider before application code decorates the
// public WebCrypto methods (Next instruments random operations during rendering).
const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const uuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);
function randomBytes(size: unknown, callback?: unknown): Buffer | undefined {
  const length = boundedNumber(size, 'crypto.randomBytes size', 0, false);
  if (callback !== undefined && typeof callback !== 'function') throw new TypeError('crypto.randomBytes callback must be a function');
  const result = Buffer.alloc(length);
  const fill = () => {
    for (let offset = 0; offset < result.length; offset += 65536) entropy(result.subarray(offset, offset + 65536));
    return result;
  };
  if (typeof callback !== 'function') return fill();
  // The existing process shim owns scheduling, async context and activity.
  scheduling.nextTick(() => {
    try { fill(); }
    catch (error) { Reflect.apply(callback, undefined, [error]); return; }
    Reflect.apply(callback, undefined, [null, result]);
  });
  return undefined;
}
function randomUUID(options?: unknown): string {
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError('crypto.randomUUID options must be an object');
    if ('disableEntropyCache' in options && options.disableEntropyCache !== undefined && typeof options.disableEntropyCache !== 'boolean') throw new TypeError('crypto.randomUUID disableEntropyCache must be a boolean');
  }
  return uuid();
}
export const nodeCrypto = { createHash, getHashes: () => Object.keys(algorithms), hash, timingSafeEqual, createHmac, pbkdf2Sync, randomBytes, randomUUID,
  // The synchronous Node backend provides neither ECDH curves nor ciphers.
  getCurves: (): string[] => [], getCiphers: (): string[] => [],
  getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
};

/** Pending browser crypto work retains the existing process activity owner.
 * Keep native receivers, keys and brands; restore methods with the process. */
export function createNodeCrypto(retain: () => () => void, scheduler?: ProcessScheduler) {
  const provider = globalThis.crypto;
  const restore: (() => void)[] = [];
  for (const name of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'generateKey',
    'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey'] as const) {
    const original = Object.getOwnPropertyDescriptor(provider.subtle, name);
    const operation: unknown = Reflect.get(provider.subtle, name);
    if (typeof operation !== "function") throw new TypeError(`Missing crypto.subtle.${name}`);
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const release = retain();
      try {
        const result: unknown = Reflect.apply(operation, this, args);
        if (!(result instanceof Promise)) throw new TypeError(`crypto.subtle.${name} did not return a Promise`);
        const completion = scheduler === undefined ? result : result.then(
          (value: unknown) => scheduler.execute(() => value),
          (error: unknown) => scheduler.execute(() => { throw error; }),
        );
        return completion.finally(release);
      } catch (error) { release(); throw error; }
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(operation));
    Object.defineProperty(provider.subtle, name, { configurable: true, writable: true, value: wrapped });
    restore.push(() => {
      if (original === undefined) Reflect.deleteProperty(provider.subtle, name);
      else Object.defineProperty(provider.subtle, name, original);
    });
  }
  return { module: { ...nodeCrypto, subtle: provider.subtle, webcrypto: provider },
    restore: () => { for (const reset of restore.splice(0).reverse()) reset(); } };
}
