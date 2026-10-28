import {generateKeyPairSync} from "node:crypto";
import {expect, it} from "vitest";
import {defineShippedSnapshot, isShippedSnapshotRef} from "../../shipped-snapshot.js";
import {decodeShippedSource, serializeShippedSnapshot} from "./shipped-source.js";
import {decodeFrameOptions, encodeFrameOptions} from "../../frame/protocol/options.js";
import {decodePublicVMOptions} from "../../vm-options.js";
const publicKey = generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"der"}).toString("base64");
it.each(["system", "userspace"] as const)("reference_roundtrip_is_exact_for_%s", mode => {
  const ref = defineShippedSnapshot({mode,name:"ready",manifestUrl:"/ready/manifest.json",manifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32),manifestBytes:10,downloadBytes:100,trust:{algorithm:"Ed25519",keyId:"B",publicKey}});
  const source = decodeShippedSource({kind:"reference",reference:serializeShippedSnapshot(ref)});
  expect(source).toEqual({kind:"reference",reference:serializeShippedSnapshot(ref)});
  expect(() => decodeShippedSource({...source,extra:1})).toThrow();
  const decoded = decodeFrameOptions(encodeFrameOptions(decodePublicVMOptions({mode,shippedSnapshot:ref,restorePoint:"latest"}),"https://app.example.test/"), "/oxidevm/runtime/");
  expect(isShippedSnapshotRef(decoded.shipped, mode)).toBe(true);
  if (typeof decoded.shipped === "object") expect(decoded.shipped.manifestUrl).toBe("https://app.example.test/ready/manifest.json");
});
