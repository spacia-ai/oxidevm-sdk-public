import {generateKeyPairSync} from "node:crypto";
import {describe, expect, it} from "vitest";
import {defineShippedSnapshot, isShippedSnapshotRef} from "./shipped-snapshot.js";
import {decodePublicVMOptions} from "./vm-options.js";
import {decodeFrameOptions,encodeFrameOptions} from "./frame/protocol/options.js";

const publicKey = generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "der"}).toString("base64");
const location = {
  mode: "userspace", name: "ready", manifestUrl: "/snapshots/ready/manifest.json",
  manifestSHA256: "ab".repeat(32), imageManifestSHA256: "cd".repeat(32),
  manifestBytes: 1024, downloadBytes: 2048,
  trust: {algorithm: "Ed25519", keyId: "state-author", publicKey},
} as const;

describe("standalone shipped snapshot references", () => {
  it("preserves image preparation and interceptor opt-out with a prepared frame start", () => {
    const options=decodePublicVMOptions({mode:"userspace",workspaceId:"prepared",shippedSnapshot:defineShippedSnapshot(location),
      imagePreparation:"before-ready",commandInterceptors:"off",restorePoint:"latest",runtime:{hosting:"frame"}});
    const received=decodeFrameOptions(encodeFrameOptions(options,"https://page.test/app/"),"/engine/");
    expect(received).toMatchObject({mode:"userspace",workspaceId:"prepared",imagePreparation:"before-ready",interceptors:false,
      resume:"latest",shipped:{mode:"userspace",manifestUrl:"https://page.test/snapshots/ready/manifest.json",manifestSHA256:location.manifestSHA256}});
  });
  it("constructs_without_browser_or_network", () => {
    const ref = defineShippedSnapshot(location);
    expect(ref.manifestUrl).toBe("/snapshots/ready/manifest.json");
    expect(ref.imageManifestSHA256).toBe("cd".repeat(32));
    expect(Object.isFrozen(ref)).toBe(true);
  });
  it("freezes_copy_of_trust", () => {
    const trust: {algorithm:"Ed25519";keyId:string;publicKey:string} = {...location.trust};
    const url = new URL("https://assets.example.test/ready.json");
    const ref = defineShippedSnapshot({...location, manifestUrl: url, trust});
    trust.keyId = "different";
    url.pathname = "/other.json";
    expect(ref.trust.keyId).toBe("state-author");
    expect(Object.isFrozen(ref.trust)).toBe(true);
    expect(ref.manifestUrl).toBe("https://assets.example.test/ready.json");
  });
  it("rejects_structural_spoof", () => {
    const ref = defineShippedSnapshot(location);
    expect(isShippedSnapshotRef(ref, "userspace")).toBe(true);
    expect(isShippedSnapshotRef({...ref}, "userspace")).toBe(false);
    expect(() => decodePublicVMOptions({mode: "userspace", shippedSnapshot: {...ref}})).toThrow();
  });
  it("rejects_extra_fields_or_unsafe_url", () => {
    const extra = {...location, extra: true};
    expect(() => defineShippedSnapshot(extra)).toThrow();
    for (const manifestUrl of ["//other.test/a", "http://other.test/a", "/a/%2e%2e/b", "file:///a"]) {
      expect(() => defineShippedSnapshot({...location, manifestUrl})).toThrow();
    }
    expect(() => defineShippedSnapshot({...location, trust: {...location.trust, publicKey: Buffer.alloc(44).toString("base64")}})).toThrow();
    for (const downloadBytes of [0, 1023, 16 * 1024 ** 3 + 1, Number.NaN]) {
      expect(() => defineShippedSnapshot({...location, downloadBytes})).toThrow();
    }
    expect(() => defineShippedSnapshot({...location, manifestBytes: 4 * 1024 ** 2 + 1025, downloadBytes: 8 * 1024 ** 2})).toThrow();
    expect(() => defineShippedSnapshot({...location, manifestSHA256: "AB".repeat(32)})).toThrow();
  });
  it("rejects_wrong_mode_reference", () => {
    const shipped = defineShippedSnapshot(location);
    expect(isShippedSnapshotRef(shipped, "system")).toBe(false);
    expect(() => decodePublicVMOptions({mode: "system", shippedSnapshot: shipped})).toThrow();
    expect(decodePublicVMOptions({mode: "userspace", shippedSnapshot: shipped}).shipped).toBe(shipped);
    expect(decodePublicVMOptions({mode: "userspace", shippedSnapshot: "ready"}).shipped).toBe("ready");
  });
});
