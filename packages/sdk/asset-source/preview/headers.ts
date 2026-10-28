export const PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'; form-action 'self'",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Service-Worker-Allowed": "/",
  "X-Content-Type-Options": "nosniff",
};
