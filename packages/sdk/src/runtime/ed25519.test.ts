import { afterEach, expect, it, vi } from "vitest";
import { verifyEd25519 } from "./ed25519.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(length: number): Promise<{ publicKey: Uint8Array<ArrayBuffer>;
  message: Uint8Array<ArrayBuffer>; signature: string }> {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const message = Uint8Array.from({ length }, (_, index) => index % 251);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, message));
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)), message,
    signature: btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") };
}

it("verifies large signed manifests without entering the libgcrypt native message limit", async () => {
  const fixtures = await Promise.all([32 * 1024 + 1, 100_000, 1024 * 1024].map(fixture));
  const native = vi.spyOn(crypto.subtle, "verify").mockRejectedValue(new Error("native renderer would crash"));
  for (const { publicKey, signature, message } of fixtures) {
    await expect(verifyEd25519(publicKey, signature, message, "image")).resolves.toBeUndefined();
  }
  expect(native).not.toHaveBeenCalled();
});

it("retains native verification for small records and the admitted size boundary", async () => {
  const fixtures = await Promise.all([0, 32 * 1024].map(fixture));
  const native = vi.spyOn(crypto.subtle, "verify");
  for (const { publicKey, signature, message } of fixtures) {
    await expect(verifyEd25519(publicKey, signature, message, "checkpoint")).resolves.toBeUndefined();
  }
  expect(native).toHaveBeenCalledTimes(2);
});

it("rejects changes at either end of a large manifest and signatures under another key", async () => {
  const signed = await fixture(100_000);
  for (const offset of [0, signed.message.length - 1]) {
    const changed = signed.message.slice();
    changed[offset] = 255;
    await expect(verifyEd25519(signed.publicKey, signed.signature, changed, "image")).rejects.toThrow("image signature is invalid");
  }
  const other = await fixture(1);
  await expect(verifyEd25519(other.publicKey, signed.signature, signed.message, "image")).rejects.toThrow("image signature is invalid");
});

it("rejects small-order identity keys rather than admitting ZIP215 forgery semantics", async () => {
  const publicKey = new Uint8Array(32); publicKey[0] = 1;
  const signature = new Uint8Array(64); signature[0] = 1;
  const encoded = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  await expect(verifyEd25519(publicKey, encoded, new Uint8Array(100_000), "image")).rejects.toThrow("image signature is invalid");
});
