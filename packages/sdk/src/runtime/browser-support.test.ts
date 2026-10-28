import { describe, expect, it } from "vitest";

import {
  assertBrowserSupport,
  type BrowserFeatureProbe,
  detectBrowserSupport,
  MINIMUM_BROWSERS,
} from "./browser-support.js";
import { VMError } from "./errors.js";

/** A probe backed by this engine that rejects any module containing `rejectOpcode`. */
function probe(options: {
  readonly rejectOpcode?: number;
  readonly validateThrows?: boolean;
  readonly promiseWithResolvers?: boolean;
}): BrowserFeatureProbe {
  return {
    validateWasm(bytes) {
      if (options.validateThrows === true) throw new TypeError("validate failed");
      if (options.rejectOpcode !== undefined && bytes.includes(options.rejectOpcode)) return false;
      return WebAssembly.validate(bytes);
    },
    hasPromiseWithResolvers: () => options.promiseWithResolvers ?? true,
  };
}

describe("browser support", () => {
  it("accepts an engine with every required feature", () => {
    // Node 24's V8 has Wasm SIMD and tail calls, which also proves the probe modules are valid.
    expect(detectBrowserSupport()).toEqual({ supported: true });
  });

  it("names Wasm tail calls when the engine rejects return_call", () => {
    expect(detectBrowserSupport(probe({ rejectOpcode: 0x12 }))).toEqual({
      supported: false,
      missing: ["wasm-tail-calls"],
    });
  });

  it("names Wasm SIMD when the engine rejects the v128 prefix", () => {
    expect(detectBrowserSupport(probe({ rejectOpcode: 0xfd }))).toEqual({
      supported: false,
      missing: ["wasm-simd"],
    });
  });

  it("names Promise.withResolvers when the runtime lacks it", () => {
    expect(detectBrowserSupport(probe({ promiseWithResolvers: false }))).toEqual({
      supported: false,
      missing: ["promise-with-resolvers"],
    });
  });

  it("treats a failing WebAssembly.validate as missing Wasm features", () => {
    expect(detectBrowserSupport(probe({ validateThrows: true }))).toEqual({
      supported: false,
      missing: ["wasm-simd", "wasm-tail-calls"],
    });
  });

  it("refuses to load a core with a typed error naming the missing features", () => {
    let thrown: unknown;
    try {
      assertBrowserSupport(probe({ rejectOpcode: 0x12 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VMError);
    expect(thrown).toMatchObject({
      code: "CORE_LOAD_FAILED",
      detail: { reason: "browser-unsupported", missing: ["wasm-tail-calls"] },
    });
    expect(() => {
      assertBrowserSupport(probe({}));
    }).not.toThrow();
  });

  it("lists the oldest supported version of every browser in the matrix", () => {
    expect(MINIMUM_BROWSERS).toEqual([
      { browser: "Chrome", version: "119" },
      { browser: "Edge", version: "119" },
      { browser: "Firefox", version: "121" },
      { browser: "Safari", version: "18.2" },
    ]);
  });
});
