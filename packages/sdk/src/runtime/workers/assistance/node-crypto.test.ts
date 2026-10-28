import { Buffer } from 'buffer/';
import { Buffer as NativeBuffer } from 'node:buffer';
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNodeCrypto, nodeCrypto } from './node-crypto.ts';

it('advertises only executable hash algorithms and returns an independent list', () => {
  const algorithms = nodeCrypto.getHashes();
  expect(algorithms).toContain('sha512');
  for (const algorithm of algorithms) expect(nodeCrypto.createHash(algorithm).update('qualified code roots').digest('hex'))
    .toBe(createHash(algorithm).update('qualified code roots').digest('hex'));
  algorithms.length = 0;
  expect(nodeCrypto.getHashes()).toContain('sha512');
});

it('compares equal-length buffer sources as bytes for authenticated connections', () => {
  for (const length of [0, 1, 32, 513]) {
    const left = Uint8Array.from({ length: length + 4 }, (_, index) => index & 255).subarray(2, length + 2);
    const right = left.slice();
    expect(nodeCrypto.timingSafeEqual(left, right.buffer)).toBe(Reflect.apply(timingSafeEqual, undefined, [left, right.buffer]));
    for (let index = 0; index < length; index++) {
      right[index] = (left[index] ?? 0) ^ 1;
      expect(nodeCrypto.timingSafeEqual(left, new DataView(right.buffer))).toBe(timingSafeEqual(left, right));
      right[index] = left[index] ?? 0;
    }
  }
  expect(nodeCrypto.timingSafeEqual(new Uint16Array([1, 2]), new Uint16Array([1, 2]))).toBe(true);
  for (const [left, right, code, constructor] of [
    [new Uint8Array(1), new Uint8Array(2), 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', RangeError],
    ['token', Buffer.from('token'), 'ERR_INVALID_ARG_TYPE', TypeError],
  ] as const) {
    let thrown: unknown;
    try { nodeCrypto.timingSafeEqual(left, right); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code }); expect(thrown).toBeInstanceOf(constructor);
  }
});

it('matches one-shot hash defaults, explicit encodings and byte input', () => {
  for (const input of ['vite lockfile', Uint8Array.of(0, 128, 255)]) {
    expect(nodeCrypto.hash('sha256', input)).toBe(createHash('sha256').update(input).digest('hex'));
    expect(nodeCrypto.hash('sha256', input, 'base64')).toBe(createHash('sha256').update(input).digest('base64'));
    const raw = nodeCrypto.hash('sha256', input, 'buffer');
    expect(typeof raw).not.toBe('string');
    if (typeof raw === 'string') throw new Error('Expected raw digest bytes');
    expect(Array.from(raw)).toEqual(Array.from(createHash('sha256').update(input).digest()));
  }
  expect(() => nodeCrypto.hash('unsupported', 'input')).toThrow(/crypto.hash/u);
  expect(() => nodeCrypto.hash('sha256', 1)).toThrow(TypeError);
  expect(() => nodeCrypto.hash('sha256', 'input', 'unknown')).toThrow();
});

it('hashes incrementally, copies unfinished state and rejects reuse after digest', () => {
  for (const algorithm of ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'md5', 'ripemd160']) {
    const hash = nodeCrypto.createHash(algorithm).update('first');
    const copy = hash.copy();
    expect(hash.update('second').digest('hex')).toBe(createHash(algorithm).update('firstsecond').digest('hex'));
    expect(copy.update(Buffer.from([0, 255])).digest('base64')).toBe(createHash(algorithm).update('first').update(new Uint8Array([0, 255])).digest('base64'));
    expect(() => hash.update('late')).toThrow();
    expect(() => hash.digest()).toThrow();
    expect(() => hash.copy()).toThrow();
  }
  expect(Buffer.isBuffer(nodeCrypto.createHash('sha256').digest('unknown'))).toBe(true);
  expect(nodeCrypto.createHash('SHA-256').update('a', 'unknown').digest('hex')).toBe(createHash('sha256').update('a').digest('hex'));
  expect(() => nodeCrypto.createHash('unsupported')).toThrow(/crypto.createHash/u);
});

it('matches native HMAC and synchronous password derivation', () => {
  const key = Buffer.from([0, 1, 255]);
  const mac = nodeCrypto.createHmac('sha256', key).update('message');
  expect(mac.digest('hex')).toBe(createHmac('sha256', key).update('message').digest('hex'));
  expect(mac.digest('hex')).toBe('');
  expect(() => mac.update('late')).toThrow();
  expect(nodeCrypto.pbkdf2Sync('password', 'salt', 2, 48, 'sha512').toString('hex')).toBe(pbkdf2Sync('password', 'salt', 2, 48, 'sha512').toString('hex'));
  expect(() => nodeCrypto.pbkdf2Sync('password', 'salt', 0, 32, 'sha256')).toThrow();
  expect(() => nodeCrypto.pbkdf2Sync('password', 'salt', 2, 0, 'sha256')).toThrow();
  expect(() => nodeCrypto.pbkdf2Sync('password', 'salt', 2, '32', 'sha256')).toThrow(TypeError);
});

it('hashes through the real stream implementation and returns Buffer digests', async () => {
  const hash = nodeCrypto.createHash('sha256');
  const output: unknown[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    hash.on('data', value => output.push(value));
    hash.on('end', () => resolve());
    hash.on('error', reject);
  });
  hash.write('first'); hash.end('second');
  await ended;
  expect(output).toHaveLength(1);
  // readable-stream uses native buffers under its Node entrypoint; the browser
  // entrypoint uses the pinned buffer package instead.
  expect(NativeBuffer.isBuffer(output[0])).toBe(true);
  expect(Buffer.isBuffer(nodeCrypto.createHash('sha256').digest())).toBe(true);
  expect(String(output[0])).toBe(createHash('sha256').update('firstsecond').digest().toString());
});

it('uses browser entropy across its chunk limit and schedules callbacks in their process context', async () => {
  const { createAsyncContext } = await import('./async-context.ts');
  const { createNodeStreamModule } = await import('./node-streams.ts');
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  let pending = 0;
  const streams = createNodeStreamModule(context, () => { pending++; return () => { pending--; }; });
  try {
    const bytes = nodeCrypto.randomBytes(65537);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes?.length).toBe(65537);
    expect(nodeCrypto.randomUUID({ disableEntropyCache: true })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const values = ['one', 'two'].map(label => storage.run(label, () => new Promise<void>((resolve, reject) => {
      const returned = nodeCrypto.randomBytes(32, (error: unknown, value: unknown) => {
        try {
          expect(error).toBeNull();
          expect(Buffer.isBuffer(value)).toBe(true);
          expect(storage.getStore()).toBe(label);
          resolve();
        } catch (failure) { reject(failure instanceof Error ? failure : new Error(String(failure))); }
      });
      expect(returned).toBeUndefined();
    })));
    expect(pending).toBe(2);
    await Promise.all(values);
    expect(pending).toBe(0);
    expect(nodeCrypto.randomBytes(1.9)?.length).toBe(1);
    expect(() => nodeCrypto.randomBytes(-1)).toThrow();
    expect(() => nodeCrypto.randomBytes(1, 2)).toThrow();
  } finally { streams.restore(); }
});

it('retains pending WebCrypto operations through success and rejection', async () => {
  let pending = 0;
  const original: unknown = Reflect.get(globalThis.crypto.subtle, "digest");
  const owner = createNodeCrypto(() => { pending++; return () => { pending--; }; });
  const crypto = owner.module;
  try {
    expect(crypto.webcrypto).toBe(globalThis.crypto);
    const digest = crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(pending).toBe(1);
    const result = await digest;
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(pending).toBe(0);
    const failure = crypto.webcrypto.subtle.digest('unsupported', new Uint8Array());
    expect(pending).toBe(1);
    await expect(failure).rejects.toThrow();
    expect(pending).toBe(0);
    expect(crypto.webcrypto.subtle).toBe(crypto.subtle);
  } finally { owner.restore(); }
  const restored: unknown = Reflect.get(globalThis.crypto.subtle, "digest");
  expect(restored).toBe(original);
});
