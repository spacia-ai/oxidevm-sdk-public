import { afterEach, expect, it, vi } from "vitest";
import { checkForImageUpdate, imageUpdateSignal } from "./image-update.js";
import { defineImage, type ImageInfo } from "./image.js";
import { decodeSHA256 } from "./values.js";
import { verifyImage } from "./verified-image.js";
vi.mock("./verified-image.js", () => ({ verifyImage: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("validates update options at the public boundary",()=>{
  for(const value of [null,[],{signal:"abort"},{extra:true}])expect(()=>imageUpdateSignal(value)).toThrow();
  const signal=new AbortController().signal;expect(imageUpdateSignal({signal})).toBe(signal);
});
async function requested() {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return defineImage({ mode: "userspace", manifestUrl: "https://images.test/new.json", manifestSHA256: "b".repeat(64),
    trust: { algorithm: "Ed25519", keyId: "test", publicKey: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey)))) } });
}
const old: ImageInfo = { id: "image", version: "old", mode: "userspace", manifestSHA256: decodeSHA256("a".repeat(64), "fixture"), cpuProfile: "x86-64-v2", signatureVerified: true, keyId: "test" };
it("returns only verified configured-image offers and ignores a result after image replacement", async () => {
  const ref = await requested(), next: ImageInfo = { ...old, version: "new", manifestSHA256: ref.manifestSHA256 };
  vi.mocked(verifyImage).mockResolvedValue({ info: next, memoryMiB: 256 });
  expect(await checkForImageUpdate(ref, () => old, "https://page.test/")).toEqual(next);
  expect(await checkForImageUpdate(ref, () => next, "https://page.test/")).toBeNull();
  let actual = old;
  vi.mocked(verifyImage).mockImplementation(() => { actual = next; return Promise.resolve({ info: next, memoryMiB: 256 }); });
  expect(await checkForImageUpdate(ref, () => actual, "https://page.test/")).toBeNull();
  actual = old;
  vi.mocked(verifyImage).mockImplementation(() => { actual = { ...old }; return Promise.resolve({ info: next, memoryMiB: 256 }); });
  expect(await checkForImageUpdate(ref, () => actual, "https://page.test/")).toBeNull();
});
it("propagates failure and cancellation without activating any image", async () => {
  const ref = await requested();
  vi.mocked(verifyImage).mockRejectedValue(new Error("unavailable"));
  await expect(checkForImageUpdate(ref, () => old, "https://page.test/")).rejects.toThrow("unavailable");
  await expect(checkForImageUpdate(ref, () => old, "https://page.test/", AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
});
