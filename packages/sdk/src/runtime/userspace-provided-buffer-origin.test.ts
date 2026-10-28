import { describe, expect, it } from "vitest";
import { decodeBufferProgress } from "./userspace-buffer-progress.ts";

function provided(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(992), view = new DataView(bytes.buffer);
  bytes[232] = 31; bytes[234] = 1; bytes[584] = 1; bytes[610] = 1;
  view.setUint16(586, 9, true); view.setUint16(608, 7, true);
  view.setUint32(588, 257, true); view.setUint32(592, 257, true); view.setUint32(596, 4, true);
  for (const [at, value] of [[600, 0x1234n], [616, 8n], [960, 57n], [968, 92n], [976, 58n], [984, 93n]] as const) view.setBigUint64(at, value, true);
  return bytes;
}

function decode(bytes: Uint8Array, version = 43) {
  return decodeBufferProgress(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, version);
}

describe("provided-buffer allocation origins", () => {
  it("links each copied provision to its actual run and group allocations", () => {
    expect(decode(provided())).toEqual({ kind: "provide", ring: 8n, group: 9,
      count: 257, provided: 257, address: 0x1234n, length: 4, first: 7,
      allocationOrigin: { kind: "recorded", run: { allocationId: 57n, cgroupId: 92n },
        group: { allocationId: 58n, cgroupId: 93n } },
    });
  });

  it("labels restored legacy completion observations without inventing allocation IDs", () => {
    const bytes = provided(); bytes.fill(0, 960); bytes[610] = 2;
    expect(decode(bytes)).toMatchObject({ allocationOrigin: { kind: "legacy-native" } });
  });

  it("preserves historical trace records as a different missing-origin reason", () => {
    const bytes = provided().slice(0, 960); bytes[610] = 0;
    expect(decode(bytes, 42)).toMatchObject({ allocationOrigin: { kind: "historical-trace" } });
  });

  it("rejects current provisions that cross the reserved highest user page", () => {
    const bytes = provided(), view = new DataView(bytes.buffer);
    const last = (1n << 47n) - 4096n - 4n * 257n;
    view.setBigUint64(600, last, true);
    expect(decode(bytes)).toMatchObject({ address: last });
    view.setBigUint64(600, last + 1n, true);
    expect(() => decode(bytes)).toThrow();
    const historical = bytes.slice(0, 960); historical[610] = 0;
    expect(decode(historical, 42)).toMatchObject({ address: last + 1n });
  });

  it("rejects missing, partial, duplicate and mixed-origin fields", () => {
    for (const at of [960, 968, 976, 984]) {
      const bytes = provided(); new DataView(bytes.buffer).setBigUint64(at, 0n, true);
      expect(() => decode(bytes)).toThrow();
    }
    const duplicate = provided(); new DataView(duplicate.buffer).setBigUint64(976, 57n, true);
    expect(() => decode(duplicate)).toThrow();
    for (const tag of [0, 2, 3]) {
      const bytes = provided(); bytes[610] = tag;
      expect(() => decode(bytes)).toThrow();
    }
    for (const at of [611, 612, 615]) {
      const bytes = provided(); bytes[at] = 1;
      expect(() => decode(bytes)).toThrow();
    }
  });
});
