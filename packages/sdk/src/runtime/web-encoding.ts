// Node and every supported browser expose these globals. Re-exporting keeps
// workspace.ts independent from environment-specific import shims.
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
