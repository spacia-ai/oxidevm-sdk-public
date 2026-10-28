import { describe, expect, it } from "vitest";
import { PackedOverlay } from "./managed-overlay.js";

class FileHandle implements FileSystemSyncAccessHandle {
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  durable: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  failWrite = false;
  constructor(readonly name: string, readonly operations: string[]) {}
  close(): void { this.operations.push(`${this.name}:close`); }
  flush(): void { this.durable = this.bytes.slice(); this.operations.push(`${this.name}:flush`); }
  getSize(): number { return this.bytes.byteLength; }
  truncate(size: number): void {
    const next = new Uint8Array(size); next.set(this.bytes.subarray(0, size)); this.bytes = next;
  }
  read(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    const view = bytes(buffer); const offset = options?.at ?? 0;
    const length = Math.min(view.byteLength, Math.max(0, this.bytes.byteLength - offset));
    view.set(this.bytes.subarray(offset, offset + length)); return length;
  }
  write(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    if (this.failWrite) throw new DOMException("full", "QuotaExceededError");
    const view = bytes(buffer); const offset = options?.at ?? 0;
    if (offset + view.byteLength > this.bytes.byteLength) this.truncate(offset + view.byteLength);
    this.bytes.set(view, offset); this.operations.push(`${this.name}:write`); return view.byteLength;
  }
}

function bytes(buffer: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
}

function fixture(length = 8 * 1024 ** 3) {
  const operations: string[] = [];
  const index = new FileHandle("index", operations);
  const data = Array.from({ length: Math.ceil(length / (64 * 1024 ** 2)) }, (_, number) => new FileHandle(`data${number}`, operations));
  const bitmap = new Uint8Array(Math.ceil(Math.ceil(length / 4096) / 8));
  const overlay = new PackedOverlay(length, index, data, bitmap);
  operations.length = 0;
  return { length, index, data, overlay, operations, bitmap };
}

describe("packed managed disk overlay", () => {
  it("allocates only written blocks at distant logical addresses and reopens them", () => {
    const f = fixture();
    const first = new Uint8Array(4096).fill(0x5a);
    const last = new Uint8Array(4096).fill(0xa5);
    f.overlay.write(0, first);
    f.overlay.write(f.length - 4096, last);
    f.overlay.flush();
    expect(f.data.reduce((size, handle) => size + handle.getSize(), 0)).toBe(8192);
    expect(f.index.getSize()).toBeLessThan(17 * 1024 ** 2);
    const reopened = new PackedOverlay(f.length, f.index, f.data, f.bitmap);
    const output = new Uint8Array(4096);
    reopened.read(0, output); expect(output).toEqual(first);
    reopened.read(f.length - 4096, output); expect(output).toEqual(last);
    reopened.write(f.length - 4096 + 2, Uint8Array.of(1, 2));
    reopened.read(f.length - 4096, output);
    expect(output.subarray(0, 5)).toEqual(Uint8Array.of(0xa5, 0xa5, 1, 2, 0xa5));
    expect(f.data.reduce((size, handle) => size + handle.getSize(), 0)).toBe(8192);
  });

  it("flushes data before publishing mappings and rejects missing committed blocks", () => {
    const f = fixture(65536);
    f.overlay.write(0, new Uint8Array(4096).fill(7));
    f.overlay.flush();
    expect(f.operations).toEqual(["data0:write", "data0:flush", "index:write", "index:flush"]);
    const data = f.data[0]; if (data === undefined) throw new Error("missing data fixture");
    data.truncate(0);
    expect(() => new PackedOverlay(f.length, f.index, f.data, f.bitmap)).toThrow(/truncated/u);
  });

  it("never publishes a mapping after a quota failure and can reuse the failed slot", () => {
    const f = fixture(65536);
    const data = f.data[0]; if (data === undefined) throw new Error("missing data fixture");
    data.failWrite = true;
    expect(() => f.overlay.write(0, new Uint8Array(4096))).toThrow(/full/u);
    f.overlay.flush();
    expect(f.operations).not.toContain("index:write");
    data.failWrite = false;
    f.overlay.write(4096, new Uint8Array(4096).fill(9));
    f.overlay.flush();
    expect(data.getSize()).toBe(4096);
    const reopened = new PackedOverlay(f.length, f.index, f.data, f.bitmap);
    const output = new Uint8Array(4096); reopened.read(4096, output);
    expect(output[0]).toBe(9);
    expect(() => reopened.read(0, output)).toThrow(/missing/u);
  });

  it("rejects torn, duplicate and out-of-range mappings before modifying files", () => {
    for (const invalid of ["torn", "duplicate", "range"] as const) {
      const f = fixture(65536);
      f.overlay.write(0, new Uint8Array(4096)); f.overlay.flush();
      const view = new DataView(f.index.bytes.buffer);
      if (invalid === "torn") view.setUint32(36, 0, true);
      else {
        const slot = invalid === "duplicate" ? 1 : 100;
        view.setUint32(40, slot, true); view.setUint32(44, (~slot) >>> 0, true);
      }
      f.operations.length = 0;
      expect(() => new PackedOverlay(f.length, f.index, f.data, f.bitmap)).toThrow();
      expect(f.operations).toEqual([]);
    }
  });

  it("reclaims an unpublished tail after metadata failure while preserving the previous block", () => {
    const f = fixture(65536);
    f.overlay.write(0, new Uint8Array(4096).fill(4)); f.overlay.flush();
    f.bitmap[0] = 1;
    f.overlay.write(4096, new Uint8Array(4096).fill(8));
    f.index.failWrite = true;
    expect(() => f.overlay.flush()).toThrow(/full/u);
    f.index.failWrite = false;
    const reopened = new PackedOverlay(f.length, f.index, f.data, f.bitmap);
    expect(f.data[0]?.getSize()).toBe(4096);
    const output = new Uint8Array(4096); reopened.read(0, output);
    expect(output.every(byte => byte === 4)).toBe(true);
    expect(() => reopened.read(4096, output)).toThrow(/missing/u);
  });

  it("fences a missing committed mapping before reclaiming any tail", () => {
    const f = fixture(65536);
    f.overlay.write(0, new Uint8Array(4096).fill(4)); f.overlay.flush();
    f.bitmap[0] = 3;
    f.operations.length = 0;
    expect(() => new PackedOverlay(f.length, f.index, f.data, f.bitmap)).toThrow(/missing/u);
    expect(f.operations).toEqual([]);
  });

  it("rejects committed bitmap bits beyond the logical disk", () => {
    const f = fixture(4096);
    f.bitmap[0] = 2;
    expect(() => new PackedOverlay(f.length, f.index, f.data, f.bitmap)).toThrow(/bitmap/u);
    expect(f.operations).toEqual([]);
  });
});
