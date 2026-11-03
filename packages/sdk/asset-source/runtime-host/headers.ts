// The response headers the runtime frame needs wherever it is served (ADR 0021). It runs guest
// code with shared memory, so it must be cross-origin isolated inside a page of another origin:
// COOP and COEP for itself, CORP so a cross-origin-isolated page may embed it. WebAssembly needs
// 'wasm-unsafe-eval'; images and relays may live on any https origin; preview keepers are framed.
export const RUNTIME_HOST_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https: wss: blob: data: http://localhost:* http://127.0.0.1:* http://*.localhost:* ws://127.0.0.1:7337; frame-src https: http://localhost:* http://*.localhost:*; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * The module frame's response headers (engine ADR 0028), wherever it is served: the application's SDK assets when
 * self-hosted, the runtime frame's `/v/<sdk>/module-frame/` in hosted mode. The CSP comes as a header, never `<meta>`,
 * because only a header carries `sandbox allow-scripts`, which keeps the document opaque even when opened directly. Its
 * only script is the inline bootstrap, named by its sha256; workers are blob: only, and nothing may be fetched but
 * blob: URLs. CORP is `cross-origin`: Firefox checks it against the frame's opaque origin and refuses `same-origin`.
 */
export function moduleFrameHeaders(bootstrapSHA256Base64: string): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(bootstrapSHA256Base64)) throw new Error("The module frame bootstrap hash must be a base64 sha256");
  return {
    "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${bootstrapSHA256Base64}' blob: 'wasm-unsafe-eval' 'unsafe-eval'; worker-src blob:; connect-src blob:; frame-ancestors *; base-uri 'none'; form-action 'none'`,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
