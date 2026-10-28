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
