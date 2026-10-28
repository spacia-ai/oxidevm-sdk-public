import { describe, expect, it } from "vitest";
import { cryptoExtras } from "./node-crypto-extra.js";

describe("crypto extras", () => {
  it("draws uniform random integers and fills typed arrays from platform entropy, and refuses key material generation", () => {
    for (let i = 0; i < 200; i += 1) {
      const value = cryptoExtras.randomInt(10);
      expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(10);
      const ranged = cryptoExtras.randomInt(5, 8);
      expect(ranged).toBeGreaterThanOrEqual(5); expect(ranged).toBeLessThan(8);
    }
    expect(() => cryptoExtras.randomInt(8, 5)).toThrow(RangeError);
    const bytes = new Uint8Array(64);
    expect(cryptoExtras.randomFillSync(bytes)).toBe(bytes);
    expect(bytes.some(byte => byte !== 0)).toBe(true);
    const slice = new Uint8Array(16);
    cryptoExtras.randomFillSync(slice, 4, 8);
    expect([...slice.subarray(0, 4), ...slice.subarray(12)].every(byte => byte === 0)).toBe(true);
    for (const name of ["X509Certificate", "createPrivateKey", "createPublicKey", "generateKeyPairSync", "generateKeySync", "generatePrimeSync"] as const) {
      const refused = cryptoExtras[name];
      expect(() => { Reflect.apply(refused, undefined, []); }).toThrow(new RegExp(name, "u"));
    }
  });
});
