/**
 * A random name suffix: 32 hex digits from `crypto.getRandomValues`. Module code runs in workers of an opaque origin,
 * which Chromium does not treat as secure contexts, so `crypto.randomUUID` and `crypto.subtle` are absent there
 * (engine ADR 0028, WebCrypto); `getRandomValues` remains.
 */
export function uniqueSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
