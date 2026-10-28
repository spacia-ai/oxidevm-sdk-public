import { VMError } from "./errors.js";

/**
 * What OxideVM needs from the browser beyond what every supported engine has, each probed
 * directly (never by user agent). Emitted JIT modules chain blocks with Wasm tail calls and the
 * cores use Wasm SIMD; the SDK uses `Promise.withResolvers`.
 */
export type BrowserFeature = "wasm-simd" | "wasm-tail-calls" | "promise-with-resolvers";

export interface MinimumBrowser {
  readonly browser: "Chrome" | "Edge" | "Firefox" | "Safari";
  readonly version: string;
}

/**
 * The oldest versions that provide every required feature (webassembly.org/features.json and
 * MDN, checked 2026-10-05). Wasm tail calls arrived in Chrome 112, Firefox 121 and Safari 18.2,
 * `Promise.withResolvers` in Chrome 119, Firefox 121 and Safari 17.4, and Wasm SIMD earlier
 * everywhere, so tail calls and `Promise.withResolvers` set the floor.
 */
export const MINIMUM_BROWSERS: readonly MinimumBrowser[] = [
  { browser: "Chrome", version: "119" },
  { browser: "Edge", version: "119" },
  { browser: "Firefox", version: "121" },
  { browser: "Safari", version: "18.2" },
];

export type BrowserSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly missing: readonly BrowserFeature[] };

/** How features are probed; tests substitute it. */
export interface BrowserFeatureProbe {
  validateWasm(bytes: Uint8Array<ArrayBuffer>): boolean;
  hasPromiseWithResolvers(): boolean;
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** `(module (func (result v128) (v128.const i64x2 0 0)))` */
const SIMD_PROBE = Uint8Array.of(
  ...WASM_HEADER,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type 0: [] -> [v128]
  0x03, 0x02, 0x01, 0x00, // function 0: type 0
  0x0a, 0x16, 0x01, 0x14, 0x00, // code: one 20-byte body, no locals
  0xfd, 0x0c, ...new Array<number>(16).fill(0), // v128.const
  0x0b, // end
);

/** `(module (func $f (return_call $f)))` */
const TAIL_CALL_PROBE = Uint8Array.of(
  ...WASM_HEADER,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type 0: [] -> []
  0x03, 0x02, 0x01, 0x00, // function 0: type 0
  0x0a, 0x06, 0x01, 0x04, 0x00, // code: one 4-byte body, no locals
  0x12, 0x00, // return_call 0
  0x0b, // end
);

export function detectBrowserSupport(
  probe: BrowserFeatureProbe = currentBrowserProbe(),
): BrowserSupport {
  const missing: BrowserFeature[] = [];
  if (!validates(probe, SIMD_PROBE)) missing.push("wasm-simd");
  if (!validates(probe, TAIL_CALL_PROBE)) missing.push("wasm-tail-calls");
  if (!probe.hasPromiseWithResolvers()) missing.push("promise-with-resolvers");
  return missing.length === 0 ? { supported: true } : { supported: false, missing };
}

/** Refuses to load a core in a browser that lacks a required feature. */
export function assertBrowserSupport(probe?: BrowserFeatureProbe): void {
  const support = detectBrowserSupport(probe);
  if (support.supported) return;
  throw new VMError(
    "CORE_LOAD_FAILED",
    `this browser lacks features OxideVM requires: ${support.missing.join(", ")}`,
    { reason: "browser-unsupported", missing: support.missing },
  );
}

function validates(probe: BrowserFeatureProbe, bytes: Uint8Array<ArrayBuffer>): boolean {
  try {
    return probe.validateWasm(bytes);
  } catch {
    return false;
  }
}

function currentBrowserProbe(): BrowserFeatureProbe {
  const webAssembly: unknown = Reflect.get(globalThis, "WebAssembly");
  const validate: unknown = typeof webAssembly === "object" && webAssembly !== null
    ? Reflect.get(webAssembly, "validate")
    : undefined;
  return {
    validateWasm(bytes) {
      if (typeof validate !== "function") return false;
      const valid: unknown = Reflect.apply(validate, webAssembly, [bytes]);
      return valid === true;
    },
    hasPromiseWithResolvers() {
      const withResolvers: unknown = Reflect.get(Promise, "withResolvers");
      return typeof withResolvers === "function";
    },
  };
}
