import { VMError } from "../../errors.ts";

const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

function randomInt(min: unknown, max?: unknown, callback?: unknown): number {
  if (typeof max === "function") { callback = max; max = undefined; }
  let low = 0; let high: number;
  if (max === undefined) { if (typeof min !== "number") throw new TypeError("The \"max\" argument must be a safe integer"); high = min; }
  else { if (typeof min !== "number" || typeof max !== "number") throw new TypeError("The \"min\" and \"max\" arguments must be safe integers"); low = min; high = max; }
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) throw new TypeError("randomInt bounds must be safe integers");
  if (high <= low) throw Object.assign(new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${low}). Received ${high}`), { code: "ERR_OUT_OF_RANGE" });
  const range = high - low;
  if (range > 2 ** 48) throw Object.assign(new RangeError("The value of \"max - min\" is out of range. It must be <= 281474976710655"), { code: "ERR_OUT_OF_RANGE" });
  // Rejection sampling over 48 random bits keeps the draw uniform.
  const bytes = new Uint8Array(6);
  const limit = Math.floor(2 ** 48 / range) * range;
  let draw: number;
  do {
    entropy(bytes);
    draw = bytes.reduce((acc, byte) => acc * 256 + byte, 0);
  } while (draw >= limit);
  const value = low + (draw % range);
  if (typeof callback === "function") { queueMicrotask(() => { Reflect.apply(callback, undefined, [null, value]); }); }
  return value;
}

function randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
  if (!ArrayBuffer.isView(buffer)) throw new TypeError("The \"buffer\" argument must be an ArrayBufferView");
  const length = size ?? buffer.byteLength - offset;
  if (offset < 0 || length < 0 || offset + length > buffer.byteLength) throw Object.assign(new RangeError("The value of \"offset\" or \"size\" is out of range"), { code: "ERR_OUT_OF_RANGE" });
  const backing = buffer.buffer;
  if (!(backing instanceof ArrayBuffer)) throw new VMError("FEATURE_NOT_AVAILABLE", "randomFillSync over shared memory is not supported in the assisted process", { builtin: "crypto", export: "randomFillSync" });
  const view = new Uint8Array(backing, buffer.byteOffset + offset, length);
  for (let start = 0; start < view.byteLength; start += 65_536) entropy(view.subarray(start, Math.min(start + 65_536, view.byteLength)));
  return buffer;
}

const refuse = (name: string): ((...args: unknown[]) => never) => () => {
  throw new VMError("FEATURE_NOT_AVAILABLE", `crypto.${name} is not supported in the assisted process`, { builtin: "crypto", export: name });
};

/** Real random integers and fills from platform entropy; key material and
 * certificate parsing have no synchronous platform equivalent and refuse. */
export const cryptoExtras = Object.freeze({
  randomInt, randomFillSync,
  X509Certificate: refuse("X509Certificate"), createPrivateKey: refuse("createPrivateKey"), createPublicKey: refuse("createPublicKey"),
  generateKeyPairSync: refuse("generateKeyPairSync"), generateKeySync: refuse("generateKeySync"), generatePrimeSync: refuse("generatePrimeSync"),
});
