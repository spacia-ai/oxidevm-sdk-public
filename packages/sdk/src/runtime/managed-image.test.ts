import { describe, expect, it } from "vitest";

import {
  decodeManagedImageManifest,
  managedImageMachineIdentityBytes,
  managedImageUrl,
} from "./managed-image.js";

const valid = {
  schemaVersion: 2,
  id: "alpine-next-bun-x86_64",
  version: "2026.07.30",
  architecture: "x86_64",
  sourceDateEpoch: 1_785_369_600,
  memoryMiB: 1024,
  vcpus: 1,
  cpuProfile: "x86-64-v3",
  commandLine: "root=/dev/vda rw console=hvc0",
  kernel: {
    url: "./bzImage",
    bytes: 8_388_608,
    sha256: "a".repeat(64),
  },
  disk: {
    bytes: 8_388_608,
    blockBytes: 4096,
    chunkBytes: 4_194_304,
    chunks: [
      {
        index: 0,
        url: "./disk/00000000.bin",
        bytes: 4_194_304,
        sha256: "b".repeat(64),
        encoding: "gzip",
        encodedBytes: 1024,
        encodedSha256: "d".repeat(64),
      },
      {
        index: 1,
        url: "./disk/00000001.bin",
        bytes: 4_194_304,
        sha256: "c".repeat(64),
        encoding: "gzip",
        encodedBytes: 2048,
        encodedSha256: "e".repeat(64),
      },
    ],
  },
  runtimes: {
    alpine: "3.24.1",
    node: "24.18.1",
    bun: "1.3.14",
    next: "16.2.12",
  },
};

/** A shipped restore point a schema-8 profile lists. */
const SHIPPED = {
  name: "container-ready",
  manifest: { url: "./snapshots/container-ready/manifest.json", bytes: 2048, sha256: "f".repeat(64) },
  bytes: 50 * 1024 * 1024,
};

describe("managed image manifest", () => {
  it("accepts Debian/glibc only in schema seven and rejects mixed runtime identities", () => {
    const value = { ...valid, schemaVersion: 7, vcpus: { minimum: 1, maximum: 1 },
      workspaceBaseSha256: "a".repeat(64),
      runtimes: { debian: "13.7", glibc: "2.41", node: "24.18.1", bun: "1.3.14", next: "16.2.12" } };
    const url = new URL("https://profiles.example/debian/manifest.json");
    expect(decodeManagedImageManifest(value, url).runtimes).toEqual(value.runtimes);
    expect(() => decodeManagedImageManifest({ ...value, schemaVersion: 5 }, url)).toThrow();
    expect(() => decodeManagedImageManifest({ ...value, runtimes: { ...value.runtimes, alpine: "3.24" } }, url)).toThrow();
    expect(() => decodeManagedImageManifest({ ...value, runtimes: { ...value.runtimes, glibc: "" } }, url)).toThrow();
  });

  it("requires a workspace base identity in schema 5", () => {
    const value = {
      ...valid,
      schemaVersion: 5,
      vcpus: { minimum: 1, maximum: 1 },
      workspaceBaseSha256: "a".repeat(64),
    };
    const url = new URL("https://profiles.example/alpine/manifest.json");
    expect(decodeManagedImageManifest(value, url).workspaceBaseSha256).toBe("a".repeat(64));
    const missing = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceBaseSha256"),
    );
    expect(() => decodeManagedImageManifest(missing, url)).toThrow();
  });

  it("accepts a schema-six AOT catalog without including it in machine identity", () => {
    const url = new URL("https://profiles.example/alpine/manifest.json");
    const base = {
      ...valid,
      schemaVersion: 6,
      vcpus: { minimum: 1, maximum: 1 },
      workspaceBaseSha256: "a".repeat(64),
    };
    const withAot = {
      ...base,
      aot: {
        url: "./aot/catalog.json",
        bytes: 4096,
        sha256: "f".repeat(64),
      },
    };
    const decoded = decodeManagedImageManifest(withAot, url);
    expect(decoded.aot?.url.href).toBe(
      "https://profiles.example/alpine/aot/catalog.json",
    );
    expect(managedImageMachineIdentityBytes(withAot)).toEqual(
      managedImageMachineIdentityBytes(base),
    );
    expect(() => decodeManagedImageManifest({ ...withAot, unknown: true }, url)).toThrow();
  });
  it("lists schema eight's shipped restore points without including them in machine identity", () => {
    const url = new URL("https://profiles.example/boundary/2026.10.03/manifest.json");
    const base = { ...valid, schemaVersion: 8, vcpus: { minimum: 1, maximum: 1 }, workspaceBaseSha256: "a".repeat(64) };
    const withSnapshots = { ...base, snapshots: [SHIPPED] };

    const decoded = decodeManagedImageManifest(withSnapshots, url);

    expect(decoded.snapshots).toEqual([{
      name: "container-ready",
      manifest: {
        url: new URL("https://profiles.example/boundary/2026.10.03/snapshots/container-ready/manifest.json"),
        bytes: 2048,
        sha256: "f".repeat(64),
      },
      bytes: 50 * 1024 * 1024,
    }]);
    expect(managedImageMachineIdentityBytes(withSnapshots)).toEqual(managedImageMachineIdentityBytes(base));
    expect(decodeManagedImageManifest(base, url).snapshots).toBeUndefined();
  });

  it("refuses shipped restore points before schema eight, outside their folder, or malformed", () => {
    const url = new URL("https://profiles.example/boundary/2026.10.03/manifest.json");
    const base = { ...valid, vcpus: { minimum: 1, maximum: 1 }, workspaceBaseSha256: "a".repeat(64) };
    const shipped = (overrides: Record<string, unknown>) => ({ ...SHIPPED, ...overrides });
    const at = (manifestUrl: string) => shipped({ manifest: { ...SHIPPED.manifest, url: manifestUrl } });

    for (const schemaVersion of [5, 6, 7]) {
      expect(() => decodeManagedImageManifest({ ...base, schemaVersion, snapshots: [SHIPPED] }, url), String(schemaVersion)).toThrow();
    }
    for (const snapshots of [
      [at("../other/manifest.json")],
      [at("./snapshots/container-ready/../../manifest.json")],
      [at("./snapshots/other-name/manifest.json")],
      [at("https://elsewhere.example/snapshots/container-ready/manifest.json")],
      [at("./snapshots/container-ready/manifest.json?version=2")],
      [shipped({ name: "../escape" })],
      [shipped({ name: "Container" })],
      [shipped({ bytes: 0 })],
      [shipped({ extra: true })],
      [SHIPPED, SHIPPED],
      Array.from({ length: 17 }, (_, index) => shipped({ name: `example-${String(index)}`, manifest: { ...SHIPPED.manifest, url: `./snapshots/example-${String(index)}/manifest.json` } })),
      "container-ready",
    ]) {
      expect(() => decodeManagedImageManifest({ ...base, schemaVersion: 8, snapshots }, url), JSON.stringify(snapshots).slice(0, 120)).toThrow();
    }
  });

  it("resolves a browser-relative catalog URL against an explicit origin", () => {
    expect(
      managedImageUrl(
        "/profiles/alpine/manifest.json",
        "https://ide.example/workspace",
      ).href,
    ).toBe("https://ide.example/profiles/alpine/manifest.json");
  });

  it("accepts https and this machine's http origins, including *.localhost, and nothing else", () => {
    expect(managedImageUrl("http://run.localhost:4179/oxidevm/images/manifest.json").host).toBe("run.localhost:4179");
    expect(managedImageUrl("http://127.0.0.2/manifest.json").hostname).toBe("127.0.0.2");
    expect(() => managedImageUrl("http://images.example/manifest.json")).toThrow(/trustworthy/u);
    expect(() => managedImageUrl("http://localhost.example/manifest.json")).toThrow(/trustworthy/u);
  });

  it("resolves immutable artifacts relative to the manifest", () => {
    const manifest = decodeManagedImageManifest(
      valid,
      new URL("https://profiles.example/alpine/manifest.json"),
    );

    expect(manifest.kernel.url.href).toBe(
      "https://profiles.example/alpine/bzImage",
    );
    expect(manifest.disk.chunks[1]?.url.href).toBe(
      "https://profiles.example/alpine/disk/00000001.bin",
    );
  });

  it("accepts 1-4 vCPUs only in schema 3", () => {
    expect(
      decodeManagedImageManifest(
        { ...valid, schemaVersion: 3, vcpus: 4 },
        new URL("https://profiles.example/alpine/manifest.json"),
      ).vcpus,
    ).toBe(4);
    expect(() =>
      decodeManagedImageManifest(
        { ...valid, vcpus: 2 },
        new URL("https://profiles.example/alpine/manifest.json"),
      ),
    ).toThrow();
  });

  it("accepts a schema-four vCPU compatibility range", () => {
    const url = new URL("https://profiles.example/alpine/manifest.json");
    expect(
      decodeManagedImageManifest(
        { ...valid, schemaVersion: 4, vcpus: { minimum: 1, maximum: 4 } },
        url,
      ).vcpus,
    ).toBe(1);
    expect(() =>
      decodeManagedImageManifest(
        { ...valid, schemaVersion: 4, vcpus: { minimum: 4, maximum: 1 } },
        url,
      ),
    ).toThrow("vCPU range");
  });

  it.each([
    ["unknown field", { ...valid, extra: true }],
    [
      "duplicate chunk",
      {
        ...valid,
        disk: {
          ...valid.disk,
          chunks: [valid.disk.chunks[0], valid.disk.chunks[0]],
        },
      },
    ],
    [
      "invalid digest",
      { ...valid, kernel: { ...valid.kernel, sha256: "not-a-digest" } },
    ],
    [
      "invalid geometry",
      { ...valid, disk: { ...valid.disk, bytes: 8_388_609 } },
    ],
    [
      "insecure artifact",
      { ...valid, kernel: { ...valid.kernel, url: "http://example.com/kernel" } },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() =>
      decodeManagedImageManifest(
        value,
        new URL("https://profiles.example/manifest.json"),
      ),
    ).toThrow();
  });
});
