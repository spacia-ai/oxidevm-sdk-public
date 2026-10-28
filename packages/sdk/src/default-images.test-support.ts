import type { ImageLocation } from "./image.js";

// Synthetic legacy metadata exercises schema 2 without depending on shipped managed defaults.
const trust = { algorithm: "Ed25519" as const, keyId: "fixture", publicKey: "MCowBQYDK2VwAyEAmz+yeegiG5ZfqhtQl5/zfDQIy7mhqjC3H3G+sJEHYts=" };
export const legacyImageLocations = {
  system: { mode: "system", manifestUrl: "/oxidevm/images/fixture-system/manifest.json", manifestSHA256: "a".repeat(64), trust },
  userspace: { mode: "userspace", manifestUrl: "/oxidevm/images/fixture-userspace/manifest.json", manifestSHA256: "b".repeat(64), trust },
} satisfies { system: ImageLocation<"system">; userspace: ImageLocation<"userspace"> };
