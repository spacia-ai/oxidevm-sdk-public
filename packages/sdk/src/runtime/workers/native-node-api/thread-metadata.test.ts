import { expect, it } from "vitest";
import { decodeThreadMetadata } from "./thread-metadata.js";

it("validates the private shared family flag and preserves its exact buffer", () => {
  const channel = new MessageChannel(), shared = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(shared), 0, 1);
  const base = { port: channel.port1, data: null, execArgv: [], transfers: [] };
  try {
    expect(decodeThreadMetadata({ ...base, autoSelectFamily: shared }).autoSelectFamily).toBe(shared);
    expect(decodeThreadMetadata({ ...base, autoSelectFamily: null }).autoSelectFamily).toBeNull();
    for (const value of [undefined, new ArrayBuffer(4), new SharedArrayBuffer(8), new SharedArrayBuffer(0), new Int32Array(shared)]) {
      expect(() => decodeThreadMetadata({ ...base, autoSelectFamily: value })).toThrow();
    }
    Atomics.store(new Int32Array(shared), 0, 2);
    expect(() => decodeThreadMetadata({ ...base, autoSelectFamily: shared })).toThrow();
    expect(() => decodeThreadMetadata({ ...base, autoSelectFamily: null, extra: true })).toThrow();
  } finally { channel.port1.close(); channel.port2.close(); }
});
