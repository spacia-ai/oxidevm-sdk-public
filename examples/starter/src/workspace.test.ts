import { VMError } from "@oxidevm/sdk";
import { expect, it } from "vitest";
import { savedWithAnotherImageKey } from "./workspace.ts";

it("recognizes a workspace saved with an image signed by another key, and no other failure", () => {
  expect(savedWithAnotherImageKey(new VMError("PROTOCOL_ERROR", "saved with another key", { reason: "image-trust-changed", keyId: "ed25519-07c107e31f3b392da4a9cbfdf7e155d7" }))).toBe(true);
  expect(savedWithAnotherImageKey(new VMError("PROTOCOL_ERROR", "verified with another key", { reason: "untrusted-key" }))).toBe(false);
  expect(savedWithAnotherImageKey(new VMError("PROTOCOL_ERROR", "no detail"))).toBe(false);
  expect(savedWithAnotherImageKey(new VMError("STORAGE_ERROR", "other code", { reason: "image-trust-changed" }))).toBe(false);
  expect(savedWithAnotherImageKey(new Error("image-trust-changed"))).toBe(false);
});
