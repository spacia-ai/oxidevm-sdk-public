import { describe, expect, it } from "vitest";
import { CORE_API_VERSION, JIT_API_VERSION, JIT_CONTEXT_VERSION } from "./core-abi.js";

import {
  canonicalAotCatalogBytes,
  decodeAotCatalog,
  verifyAotCatalog,
} from "./aot-catalog.js";

const digest = (character: string): string => character.repeat(64);

function catalog(signature = "") {
  return {
    schemaVersion: 1,
    kind: "oxidevm-aot-catalog",
    runtime: "system",
    machineSha256: digest("a"),
    command: "/bin/busybox sha256sum /usr/local/bin/bun",
    environment: [{ name: "BUN_JSC_useConcurrentJIT", value: "false" }],
    workloadSha256: digest("b"),
    trainingSha256: [digest("1"), digest("2"), digest("3"), digest("4"), digest("5")],
    compatibility: {
      coreRuntimeKey: "9".repeat(64),
      coreApi: 7,
      jitApi: 51,
      jitContext: 31,
      ripMap: 2,
      irMap: 5,
      cpuProfile: "x86-64-v3",
      mode: "long",
      cpl: 3,
      codeAttributes: 1,
    },
    index: { url: "./index.oxai", bytes: 128, sha256: digest("c") },
    packs: [{
      url: `./${digest("d")}.wasm`,
      bytes: 1024,
      sha256: digest("d"),
      phase: "command",
      sourceSha256: digest("e"),
      memberCount: 2,
      score: 12.5,
    }],
    provenance: {
      sbom: { url: "./sbom.json", bytes: 20, sha256: digest("6") },
      notices: { url: "./notices.txt", bytes: 20, sha256: digest("7") },
      correspondingSources: { url: "./sources.json", bytes: 20, sha256: digest("8") },
      reproducibility: { url: "./reproducibility.json", bytes: 20, sha256: digest("9") },
    },
    signing: { keyId: "demo-2026", signature },
  };
}

describe("AOT catalog", () => {
  it("retains current capabilities and version meaning without changing historical signatures", () => {
    const old = catalog();
    const url = new URL("https://profiles.example/aot/catalog.json");
    const value = { ...old, schemaVersion: 2, compatibility: {
      ...old.compatibility, coreApi: CORE_API_VERSION, jitApi: JIT_API_VERSION, jitContext: JIT_CONTEXT_VERSION, capabilityRevision: 1,
    } };
    const decoded = decodeAotCatalog(value, url);
    expect(JSON.parse(new TextDecoder().decode(canonicalAotCatalogBytes(decoded)))).toEqual(value);
    const historical = decodeAotCatalog(old, url);
    expect(JSON.parse(new TextDecoder().decode(canonicalAotCatalogBytes(historical)))).toEqual(old);
    for (const capabilityRevision of [undefined, 2, 255]) {
      expect(() => decodeAotCatalog({ ...value, compatibility: {
        ...value.compatibility, capabilityRevision,
      } }, url)).toThrow();
    }
    expect(() => decodeAotCatalog({ ...value, schemaVersion: 1 }, url)).toThrow();
    for (const jitApi of [83, 85]) {
      expect(() => decodeAotCatalog({ ...value, compatibility: {
        ...value.compatibility, jitApi,
      } }, url)).toThrow();
    }
    expect(() => decodeAotCatalog({ ...value, compatibility: {
      ...value.compatibility, jitApi: 51,
    } }, url)).toThrow();
  });
  it("strictly decodes bounded artifacts relative to the catalog", () => {
    const decoded = decodeAotCatalog(
      catalog(),
      new URL("https://profiles.example/aot/catalog.json"),
    );
    expect(decoded.index.url.href).toBe("https://profiles.example/aot/index.oxai");
    expect(decoded.packs[0]?.phase).toBe("command");
    expect(() => decodeAotCatalog(
      { ...catalog(), extra: true },
      new URL("https://profiles.example/aot/catalog.json"),
    )).toThrow();
    expect(() => decodeAotCatalog(
      {
        ...catalog(),
        compatibility: { ...catalog().compatibility, coreRuntimeKey: "wrong" },
      },
      new URL("https://profiles.example/aot/catalog.json"),
    )).toThrow(/runtime key/u);
  });

  it("verifies the canonical Ed25519 signature and trusted key id", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const unsigned = decodeAotCatalog(
      catalog(),
      new URL("https://profiles.example/aot/catalog.json"),
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalAotCatalogBytes(unsigned),
    ));
    const signed = decodeAotCatalog(
      catalog(Buffer.from(signature).toString("base64url")),
      new URL("https://profiles.example/aot/catalog.json"),
    );
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    await expect(verifyAotCatalog(signed, {
      keyId: "demo-2026",
      publicKey,
    })).resolves.toBeUndefined();
    await expect(verifyAotCatalog(signed, {
      keyId: "wrong",
      publicKey,
    })).rejects.toThrow(/trusted/u);
  });

  it("rejects duplicate packs and aggregate pack overflow", () => {
    const value = catalog();
    const pack = value.packs[0];
    if (pack === undefined) throw new Error("test catalog pack is missing");
    expect(() => decodeAotCatalog(
      { ...value, packs: [pack, pack] },
      new URL("https://profiles.example/aot/catalog.json"),
    )).toThrow(/duplicate/u);
    expect(() => decodeAotCatalog(
      {
        ...value,
        packs: Array.from({ length: 33 }, (_, index) => ({
          ...pack,
          sha256: index.toString(16).padStart(64, "0"),
          url: `./${index.toString(16).padStart(64, "0")}.wasm`,
          bytes: 4 * 1024 * 1024,
        })),
      },
      new URL("https://profiles.example/aot/catalog.json"),
    )).toThrow(/bytes/u);
  });
});
