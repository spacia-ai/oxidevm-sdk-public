import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import {
  decodeSnapshotManifest,
  diskChunkSource,
  encodeSnapshotManifest,
  manifestObjects,
  readSnapshotIdentity,
  SNAPSHOT_SCHEMA,
} from "./snapshot-manifest.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const MIB = 1024 * 1024;

const MANAGED_DISK = {
  origin: "managed",
  bytes: 4 * MIB,
  baseIdentity: B,
  image: { id: "alpine", version: "2026.10.02" },
  chunks: [{ index: 0, zero: true }, { index: 2, sha256: A, bytes: MIB }],
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2,
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-10-02T10:00:00.000Z",
    kind: "named",
    label: "Before upgrading Next",
    capturedAtUnixMs: 1_790_000_000_000,
    parent: null,
    machine: { record: { sha256: A, bytes: 4096 }, memoryBytes: 16 * MIB, vcpus: 1 },
    ram: [{ index: 0, sha256: A, bytes: MIB }, { index: 3, sha256: B, bytes: MIB }],
    disk: MANAGED_DISK,
    assets: { kernel: { sha256: A, bytes: 10 } },
    ...overrides,
  };
}

describe("snapshot manifest v2", () => {
  it("records the machine shape and the managed image a restore point needs", () => {
    const decoded = decodeSystem(manifest());

    expect(decoded.machine).toEqual({ record: { sha256: A, bytes: 4096 }, memoryBytes: 16 * MIB, vcpus: 1 });
    expect(decoded.disk).toMatchObject({ origin: "managed", image: { id: "alpine", version: "2026.10.02" } });
    const record = { sha256: A, bytes: 4096 };
    for (const malformed of [
      manifest({ machine: { record, memoryBytes: 16 * MIB } }),
      manifest({ machine: { record, memoryBytes: 16 * MIB, vcpus: 0 } }),
      manifest({ machine: { record, memoryBytes: 16 * MIB, vcpus: 5 } }),
      manifest({ disk: { ...MANAGED_DISK, image: undefined } }),
      manifest({ disk: { ...MANAGED_DISK, image: { id: "", version: "2026.10.02" } } }),
      manifest({ disk: { ...MANAGED_DISK, image: { id: "alpine" } } }),
      manifest({ disk: { ...MANAGED_DISK, image: { id: "alpine", version: "2026.10.02", identity: B } } }),
    ]) {
      expect(() => decodeSnapshotManifest(JSON.parse(JSON.stringify(malformed))), JSON.stringify(malformed)).toThrow(VMError);
    }
  });

  it("carries the host side of the guest-agent session as an object", () => {
    const agent = { sha256: "c".repeat(64), bytes: 300 };
    const decoded = decodeSystem(manifest({ host: { agent } }));

    expect(decoded.host).toEqual({ agent });
    expect(manifestObjects(decoded)).toContainEqual(agent);
    expect(decodeSnapshotManifest(JSON.parse(new TextDecoder().decode(encodeSnapshotManifest(decoded))))).toEqual(decoded);
    expect(() => decodeSnapshotManifest(manifest({ host: { agent, console: agent } }))).toThrow(VMError);
    expect(() => decodeSnapshotManifest(manifest({ host: { agent: { sha256: "c".repeat(64), bytes: 0 } } }))).toThrow(VMError);
  });

  it("carries the page data saved with a restore point as an object of at most 1 MiB", () => {
    const appData = { sha256: "e".repeat(64), bytes: 200 };
    const decoded = decodeSystem(manifest({ host: { appData } }));

    expect(decoded.host).toEqual({ appData });
    expect(manifestObjects(decoded)).toContainEqual(appData);
    expect(decodeSnapshotManifest(JSON.parse(new TextDecoder().decode(encodeSnapshotManifest(decoded))))).toEqual(decoded);
    expect(() => decodeSnapshotManifest(manifest({ host: { appData: { ...appData, bytes: 1024 * 1024 + 1 } } }))).toThrow(VMError);
    expect(() => decodeSnapshotManifest(manifest({ host: {} }))).toThrow(VMError);
  });

  it("records the workspace store generation the guest matched, with its index object", () => {
    const index = { sha256: "d".repeat(64), bytes: 512 };
    const workspace = { baseSha256: B, generation: 7, index };
    const decoded = decodeSystem(manifest({ workspace }));

    expect(decoded.workspace).toEqual(workspace);
    expect(manifestObjects(decoded)).toContainEqual(index);
    expect(decodeSnapshotManifest(JSON.parse(new TextDecoder().decode(encodeSnapshotManifest(decoded))))).toEqual(decoded);
    for (const malformed of [
      { ...workspace, extra: true },
      { ...workspace, generation: 0 },
      { ...workspace, baseSha256: "not-a-digest" },
      { ...workspace, index: { sha256: "d".repeat(64), bytes: 0 } },
    ]) {
      expect(() => decodeSnapshotManifest(manifest({ workspace: malformed }))).toThrow(VMError);
    }
  });

  it("round-trips a manifest whose disk mixes zero markers and content", () => {
    const decoded = decodeSystem(manifest());

    expect(decoded).toMatchObject({ schema: SNAPSHOT_SCHEMA, kind: "named", parent: null });
    expect(decodeSnapshotManifest(JSON.parse(new TextDecoder().decode(encodeSnapshotManifest(decoded)))))
      .toEqual(decoded);
  });

  it("reads an absent disk entry as the base and a zero marker as zeros", () => {
    const decoded = decodeSystem(manifest());

    expect(diskChunkSource(decoded, 0)).toEqual({ kind: "zero" });
    expect(diskChunkSource(decoded, 1)).toEqual({ kind: "base" });
    expect(diskChunkSource(decoded, 2)).toEqual({ kind: "object", ref: { sha256: A, bytes: MIB } });
  });

  it("keeps a core disk's own base chunks", () => {
    const decoded = decodeSystem(manifest({
      disk: {
        origin: "core",
        bytes: 2 * MIB,
        baseIdentity: B,
        base: [{ index: 1, sha256: B, bytes: MIB }],
        chunks: [{ index: 1, zero: true }],
      },
    }));

    expect(decoded.disk).toMatchObject({ origin: "core", base: [{ index: 1, sha256: B, bytes: MIB }] });
    expect(diskChunkSource(decoded, 1)).toEqual({ kind: "zero" });
  });

  it("rejects the v1 schema with a typed format error", () => {
    let failure: unknown;
    try {
      decodeSnapshotManifest(manifest({ schema: 1 }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "SNAPSHOT_VERSION" });
  });

  it.each([
    ["an unknown top-level key", { extra: true }],
    ["an unknown kind", { kind: "favourite" }],
    ["a zero marker in RAM", { ram: [{ index: 0, zero: true }] }],
    ["unsorted RAM chunks", { ram: [{ index: 3, sha256: B, bytes: MIB }, { index: 0, sha256: A, bytes: MIB }] }],
    ["a chunk past the end of RAM", { ram: [{ index: 16, sha256: A, bytes: MIB }] }],
    ["a short RAM chunk", { ram: [{ index: 0, sha256: A, bytes: 4096 }] }],
    ["a label over 256 bytes", { label: "x".repeat(257) }],
    ["a malformed hash", { machine: { record: { sha256: "A".repeat(64), bytes: 4096 }, memoryBytes: 16 * MIB, vcpus: 1 } }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => decodeSnapshotManifest(manifest(overrides))).toThrow(VMError);
  });

  it.each([
    ["a zero marker carrying content", [{ index: 0, zero: true, sha256: A, bytes: MIB }]],
    ["a duplicate disk index", [{ index: 0, zero: true }, { index: 0, sha256: A, bytes: MIB }]],
    ["a disk chunk past the end", [{ index: 4, zero: true }]],
  ])("rejects a disk with %s", (_name, chunks) => {
    const disk = { ...MANAGED_DISK, chunks };
    expect(() => decodeSnapshotManifest(manifest({ disk }))).toThrow(VMError);
  });
});

function decodeSystem(value: unknown) {
  const manifest = decodeSnapshotManifest(value);
  if (manifest.schema !== 2) throw new Error("expected system fixture");
  return manifest;
}

describe("snapshot identity runtime mode", () => {
  const identity = { createdAt: "2026-10-19T00:00:00.000Z", kind: "automatic", capturedAtUnixMs: 1 } as const;
  it("reads a userspace mode, and an absent mode as the system runtime", () => {
    expect(readSnapshotIdentity({ ...identity, mode: "userspace" })).toMatchObject({ mode: "userspace" });
    expect(readSnapshotIdentity({ ...identity })).toMatchObject({ mode: "system" });
  });
  it("never lists a retired or unknown mode as the system runtime", () => {
    const retired = readSnapshotIdentity({ ...identity, mode: "linux-user" });
    expect(retired).not.toMatchObject({ mode: "system" });
    expect(retired).toEqual(readSnapshotIdentity(null));
  });
});
