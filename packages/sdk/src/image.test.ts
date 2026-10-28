import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defineImage, VMError } from "./index.js";

const publicKey = generateKeyPairSync("ed25519").publicKey
  .export({ type: "spki", format: "der" }).toString("base64");
const trust = { algorithm: "Ed25519", keyId: "test-author", publicKey } as const;
const manifestSHA256 = "ab".repeat(32);

describe("immutable, externally trusted managed image references", () => {
  it("pins mode, digest and public trust without browser globals", () => {
    const image = defineImage({ mode: "userspace", manifestUrl: "/images/python/image.json", manifestSHA256, trust });
    expect(image.mode).toBe("userspace");
    expect(image.manifestUrl).toBe("/images/python/image.json");
    expect(image.manifestSHA256).toBe(manifestSHA256);
    expect(Object.isFrozen(image)).toBe(true);
    expect(Object.isFrozen(image.trust)).toBe(true);
  });

  it("copies mutable URL and trust inputs", () => {
    const url = new URL("https://assets.example.test/python/image.json");
    const author = { ...trust, keyId: "test-author" };
    const image = defineImage({ mode: "system", manifestUrl: url, manifestSHA256, trust: author });
    url.pathname = "/replacement.json";
    author.keyId = "replacement";
    expect(image.manifestUrl).toBe("https://assets.example.test/python/image.json");
    expect(image.trust.keyId).toBe("test-author");
  });

  it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])("rejects invalid manifest digest %s", hash => {
    expect(() => defineImage({ mode: "system", manifestUrl: "/image.json", manifestSHA256: hash, trust })).toThrow(VMError);
  });

  it.each(["file:///image.json", "javascript:alert(1)", "//evil.example/image.json", "../image.json", "http://untrusted.example/image.json", "/images/../image.json", "/images/%2e%2e/image.json"]) (
    "rejects unsafe or ambiguous location %s", manifestUrl => {
      expect(() => defineImage({ mode: "system", manifestUrl, manifestSHA256, trust })).toThrow(VMError);
    },
  );

  it("rejects malformed and non-Ed25519 SPKI bytes", () => {
    for (const value of ["", "invalid", Buffer.alloc(44).toString("base64")]) {
      expect(() => defineImage({ mode: "system", manifestUrl: "/image.json", manifestSHA256, trust: { ...trust, publicKey: value } })).toThrow(VMError);
    }
  });

  it("accepts HTTPS and trustworthy loopback HTTP locations", () => {
    for (const manifestUrl of ["https://assets.example.test/image.json", "http://localhost:5173/image.json", "http://127.0.0.1:5173/image.json", "http://[::1]:5173/image.json"]) {
      expect(defineImage({ mode: "system", manifestUrl, manifestSHA256, trust }).manifestUrl).toBe(manifestUrl);
    }
  });
});
