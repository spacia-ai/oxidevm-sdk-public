import { expect, it } from "vitest";
import { decodeStarterRelease } from "./starter-release.js";

it("pins the public starter to the matching packages, engine, image and independent author trust", () => {
  const engine = "a".repeat(64), compliance = "b".repeat(64);
  const value = { schemaVersion: 2, sdkVersion: "0.0.1", engineRelease: engine, engineCompliance: { url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${compliance}/compliance.json`, bytes: 100, sha256: compliance }, image: { mode: "userspace", manifestUrl: "https://cdn.oxidevm.dev/images/oxidevm-starter-nginx/0.0.1/manifest.json", manifestSHA256: "c".repeat(64), trust: { algorithm: "Ed25519", keyId: "fixture", publicKey: "MCowBQYDK2VwAyEAqa1J60wlujbHvQ5zc11ydVv2ZlAFvjX7FyMwF6Yn3cs=" } }, archive: { url: "https://cdn.oxidevm.dev/images/oxidevm-starter-nginx/0.0.1/image.tgz", bytes: 1000, sha256: "d".repeat(64) }, materialsSHA256: "e".repeat(64), materialsUrl: "https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.1/OPEN-SOURCE-NOTICE.md" };
  expect(decodeStarterRelease(value, "0.0.1", `sha256:${engine}`).sdkVersion).toBe("0.0.1");
  expect(() => decodeStarterRelease(value, "0.0.2", `sha256:${engine}`)).toThrow(/version/u);
  expect(() => decodeStarterRelease(value, "0.0.1", `sha256:${"f".repeat(64)}`)).toThrow(/engine/u);
  expect(() => decodeStarterRelease({ ...value, materialsUrl: "https://private.invalid/materials" }, "0.0.1", `sha256:${engine}`)).toThrow(/GitHub/u);
  expect(() => decodeStarterRelease({ ...value, extra: true }, "0.0.1", `sha256:${engine}`)).toThrow();
  expect(() => decodeStarterRelease({ ...value, archive: { ...value.archive, url: "https://private.invalid/image" } }, "0.0.1", `sha256:${engine}`)).toThrow(/CDN/u);
});
