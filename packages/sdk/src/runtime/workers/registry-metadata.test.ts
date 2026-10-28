import { expect, it } from "vitest";
import { RegistryMetadata } from "./registry-metadata.js";

const origin = "https://registry.npmjs.org";
const gateway = "http://127.0.0.1:1234";
it("streams large unrelated metadata and split UTF-8 without changing JSON lexemes", () => {
  const source = '{"time":{"note":"' + "🦀\\\"\\\\".repeat(100_000) + '"},"versions":{"1":{"dist":{"tarball":"https://registry.npmjs.org/a.tgz"}}},"number":9007199254740993}';
  const bytes = new TextEncoder().encode(source);
  const rewrite = new RegistryMetadata(origin, gateway);
  const decoder = new TextDecoder();
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 4093) {
    output += decoder.decode(rewrite.write(bytes.subarray(offset, offset + 4093)), { stream: true });
  }
  output += decoder.decode(rewrite.write(new Uint8Array(), true));
  expect(output).toBe(source.replace(origin + "/a.tgz", gateway + "/a.tgz"));
});
it("keeps unrelated and credential-bearing URL strings unchanged", () => {
  const source = JSON.stringify({ versions: { "1": { dist: { tarball: "https://user@registry.npmjs.org/a.tgz" },
    dependencies: { dist: { tarball: origin + "/a.tgz" } } } }, time: [{ dist: { tarball: origin + "/a.tgz" } }] });
  const rewrite = new RegistryMetadata(origin, gateway);
  expect(new TextDecoder().decode(rewrite.write(new TextEncoder().encode(source), true))).toBe(source);
});
it("projects packuments to the fields pnpm installs from, blanking the rest in place", () => {
  const source = JSON.stringify({ _id: "x", name: "x", "dist-tags": { latest: "1.0.0" }, readme: "big", users: { a: true },
    time: { "1.0.0": "2026-01-01T00:00:00Z" }, versions: { "1.0.0": { name: "x", version: "1.0.0", dependencies: { y: "1" },
      devDependencies: { "a}": "\"}{[", b: [1, { c: "]" }] }, scripts: { postinstall: "node x" }, maintainers: [{ name: "m" }],
      description: "d", count: 3, flag: true, hasInstallScript: true,
      dist: { tarball: origin + "/x/-/x-1.0.0.tgz", integrity: "sha512-i", signatures: [{ sig: "s" }], "npm-signature": "-----BEGIN",
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x@1.0.0", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } } } });
  const expected = JSON.stringify({ _id: "", name: "x", "dist-tags": { latest: "1.0.0" }, readme: "", users: {},
    time: { "1.0.0": "2026-01-01T00:00:00Z" }, versions: { "1.0.0": { name: "x", version: "1.0.0", dependencies: { y: "1" },
      devDependencies: {}, scripts: {}, maintainers: [], description: "", count: 3, flag: true, hasInstallScript: true,
      dist: { tarball: gateway + "/x/-/x-1.0.0.tgz", integrity: "sha512-i", signatures: [], "npm-signature": "",
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x@1.0.0", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } } } });
  const bytes = new TextEncoder().encode(source);
  for (const step of [bytes.length, 3]) {
    const rewrite = new RegistryMetadata(origin, gateway);
    const decoder = new TextDecoder();
    let output = "";
    for (let offset = 0; offset < bytes.length; offset += step) output += decoder.decode(rewrite.write(bytes.subarray(offset, offset + step)), { stream: true });
    output += decoder.decode(rewrite.write(new Uint8Array(), true));
    expect(output).toBe(expected);
  }
});

it("rejects unbounded keys, excessive nesting, invalid UTF-8 and truncated metadata", () => {
  for (const source of ['{"' + "x".repeat(4096), "[".repeat(65), '{"dist":{"tarball":"unfinished']) {
    const rewrite = new RegistryMetadata(origin, gateway);
    const bytes = new TextEncoder().encode(source);
    expect(() => {
      for (let offset = 0; offset < bytes.length; offset += 4096) rewrite.write(bytes.subarray(offset, offset + 4096));
      rewrite.write(new Uint8Array(), true);
    }).toThrow();
  }
  expect(() => new RegistryMetadata(origin, gateway).write(new Uint8Array([255]), true)).toThrow();
});

it("keeps only trust evidence for versions outside the frozen set and blanks the root etag", () => {
  const source = JSON.stringify({ name: "x", etag: "W/\"abc\"", "dist-tags": { latest: "1.0.0" },
    time: { "0.9.0": "2025-01-01T00:00:00Z", "1.0.0": "2026-01-01T00:00:00Z" },
    versions: {
      "0.9.0": { name: "x", version: "0.9.0", dependencies: { y: "1" }, engines: { node: ">=18" }, hasInstallScript: true, count: 3,
        _npmUser: { name: "m", trustedPublisher: { id: "gha" } },
        dist: { tarball: origin + "/x/-/x-0.9.0.tgz", integrity: "sha512-old", signatures: [{ sig: "s" }],
          attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x@0.9.0", provenance: { predicateType: "p" } } } },
      "1.0.0": { name: "x", version: "1.0.0", dependencies: { y: "1" }, _npmUser: { name: "m" },
        dist: { tarball: origin + "/x/-/x-1.0.0.tgz", integrity: "sha512-new", signatures: [{ sig: "s" }] } } } });
  const expected = JSON.stringify({ name: "x", etag: "", "dist-tags": { latest: "1.0.0" },
    time: { "0.9.0": "2025-01-01T00:00:00Z", "1.0.0": "2026-01-01T00:00:00Z" },
    versions: {
      "0.9.0": { name: "", version: "", dependencies: {}, engines: {}, hasInstallScript: true, count: 3,
        _npmUser: { name: "m", trustedPublisher: { id: "gha" } },
        dist: { tarball: "", integrity: "", signatures: [],
          attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x@0.9.0", provenance: { predicateType: "p" } } } },
      "1.0.0": { name: "x", version: "1.0.0", dependencies: { y: "1" }, _npmUser: { name: "m" },
        dist: { tarball: gateway + "/x/-/x-1.0.0.tgz", integrity: "sha512-new", signatures: [] } } } });
  const bytes = new TextEncoder().encode(source);
  for (const step of [bytes.length, 5]) {
    const rewrite = new RegistryMetadata(origin, gateway, new Set(["1.0.0"]));
    const decoder = new TextDecoder();
    let output = "";
    for (let offset = 0; offset < bytes.length; offset += step) output += decoder.decode(rewrite.write(bytes.subarray(offset, offset + step)), { stream: true });
    output += decoder.decode(rewrite.write(new Uint8Array(), true));
    expect(output).toBe(expected);
  }
});
