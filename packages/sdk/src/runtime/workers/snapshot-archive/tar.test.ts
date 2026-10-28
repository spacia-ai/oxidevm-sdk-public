import { describe, expect, it } from "vitest";

import { readTar, tarEnd, tarHeader, tarPadding, type TarFile } from "./tar.js";

/**
 * The header Python's tarfile writes (USTAR format, mode 0644, uid and gid 0, mtime 0, empty
 * owner names) for a 5-byte `manifest.json`: its first 265 bytes, the rest being zero.
 */
const PYTHON_HEADER_PREFIX =
  "6d616e69666573742e6a736f6e0000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000003030303036343400303030303030300030303030303030003030303030303030303035003030303030303030" +
  "303030003031303434310020300000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000007573746172003030";

const encoder = new TextEncoder();
const LIMIT = 1024 * 1024;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function archive(files: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const parts = files.flatMap(({ name, data }) => [tarHeader(name, data.byteLength), data, tarPadding(data.byteLength)]);
  return concat([...parts, tarEnd()]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** `bytes` as a stream of pieces of `size` bytes. */
function pieces(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function read(bytes: Uint8Array, size = 4096, limit = LIMIT): Promise<TarFile[]> {
  const files: TarFile[] = [];
  for await (const file of readTar(pieces(bytes, size), () => limit)) files.push(file);
  return files;
}

/** `header` with its checksum recomputed, so a test can change one field and nothing else. */
function resealed(header: Uint8Array): Uint8Array {
  const copy = header.slice();
  copy.fill(0x20, 148, 156);
  const sum = copy.reduce((total, byte) => total + byte, 0);
  copy.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return copy;
}

/** A one-file archive whose header `change` edits, then reseals. */
function withHeader(change: (header: Uint8Array) => void, data = encoder.encode("hello")): Uint8Array {
  const header = tarHeader("manifest.json", data.byteLength).slice();
  change(header);
  return concat([resealed(header), data, tarPadding(data.byteLength), tarEnd()]);
}

async function problem(bytes: Uint8Array, limit = LIMIT): Promise<unknown> {
  try {
    await read(bytes, 4096, limit);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("deterministic tar", () => {
  it("writes the exact header Python's tarfile writes for the same file", () => {
    const expected = PYTHON_HEADER_PREFIX.padEnd(1024, "0");

    expect(hex(tarHeader("manifest.json", 5))).toBe(expected);
    expect(tarPadding(5)).toEqual(new Uint8Array(507));
    expect(tarPadding(512)).toEqual(new Uint8Array(0));
    expect(tarEnd()).toEqual(new Uint8Array(1024));
  });

  it("reads back what it writes, however the input is split", async () => {
    const files = [
      { name: "manifest.json", data: encoder.encode('{"format":"oxidevm-backup"}') },
      { name: "chunks/empty.gz", data: new Uint8Array(0) },
      { name: "chunks/block.gz", data: new Uint8Array(512).fill(7) },
      { name: "chunks/odd.gz", data: new Uint8Array(1_500).map((_, index) => index % 251) },
    ];
    const bytes = archive(files);

    for (const size of [1, 511, 512, 513, bytes.byteLength]) {
      expect(await read(bytes, size), `pieces of ${String(size)}`).toEqual(files);
    }
  });

  it("refuses a header whose checksum does not match", async () => {
    const bytes = archive([{ name: "manifest.json", data: encoder.encode("hello") }]);
    bytes[0] = 0x4d;

    expect(await problem(bytes)).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "tar-invalid", problem: "checksum" } });
  });

  it("refuses names that are empty, absolute, climb out or are not plain ASCII", async () => {
    for (const name of ["", "/etc/passwd", "../outside", "chunks/../../outside", "chunks\\x.gz", "chünks/x.gz", "a//b"]) {
      const bytes = withHeader((header) => {
        header.fill(0, 0, 100);
        header.set(encoder.encode(name).slice(0, 100), 0);
      });
      expect(await problem(bytes), name).toMatchObject({ detail: { reason: "tar-invalid", problem: "name" } });
    }
    expect(() => tarHeader("../outside", 0)).toThrow();
    expect(() => tarHeader("x".repeat(101), 0)).toThrow();
  });

  it("refuses a size that is not octal, has no terminator, or exceeds the limit", async () => {
    for (const size of ["0000000000x", "000000000055", "00000000005 "]) {
      const bytes = withHeader((header) => {
        header.set(encoder.encode(size.padEnd(12, "\0").slice(0, 12)), 124);
      });
      expect(await problem(bytes), JSON.stringify(size)).toMatchObject({ detail: { reason: "tar-invalid", problem: "size" } });
    }
    const big = archive([{ name: "manifest.json", data: new Uint8Array(100) }]);
    expect(await problem(big, 99)).toMatchObject({ detail: { reason: "tar-invalid", problem: "size" } });
  });

  it("refuses bytes after a name's terminator", async () => {
    const bytes = withHeader((header) => {
      header.set(encoder.encode("junk"), 20);
    });

    expect(await problem(bytes)).toMatchObject({ detail: { reason: "tar-invalid", problem: "header" } });
  });

  it("reads empty pieces of the input as no bytes, even after the end", async () => {
    const files = [{ name: "manifest.json", data: encoder.encode("hello") }];
    const bytes = archive(files);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0));
        controller.enqueue(bytes);
        controller.enqueue(new Uint8Array(0));
        controller.close();
      },
    });

    const read: TarFile[] = [];
    for await (const file of readTar(source, () => LIMIT)) read.push(file);

    expect(read).toEqual(files);
  });

  it("refuses fields a deterministic archive never sets", async () => {
    for (const [offset, value] of [
      [156, "5"], // a directory
      [156, "x"], // a pax extended header
      [157, "target"], // a link name
      [257, "ustaR\0"], // another magic
      [345, "prefix"], // a name prefix
      [100, "0000755\0"], // another mode
    ] as const) {
      const bytes = withHeader((header) => {
        header.set(encoder.encode(value), offset);
      });
      expect(await problem(bytes), `${String(offset)}=${value}`).toMatchObject({ detail: { reason: "tar-invalid", problem: "header" } });
    }
  });

  it("refuses padding that is not zero", async () => {
    const bytes = archive([{ name: "manifest.json", data: encoder.encode("hello") }]);
    bytes[512 + 5] = 1;

    expect(await problem(bytes)).toMatchObject({ detail: { reason: "tar-invalid", problem: "padding" } });
  });

  it("refuses an archive that ends early", async () => {
    const bytes = archive([{ name: "manifest.json", data: new Uint8Array(1_000) }]);

    for (const length of [100, 512 + 600, bytes.byteLength - 1024, bytes.byteLength - 1]) {
      expect(await problem(bytes.slice(0, length)), String(length)).toMatchObject({ detail: { reason: "tar-invalid", problem: "truncated" } });
    }
  });

  it("refuses data after the end of the archive", async () => {
    const bytes = archive([{ name: "manifest.json", data: encoder.encode("hello") }]);

    expect(await problem(concat([bytes, new Uint8Array(1)]))).toMatchObject({ detail: { reason: "tar-invalid", problem: "trailing-data" } });
    expect(await problem(concat([bytes, new Uint8Array(512)]))).toMatchObject({ detail: { reason: "tar-invalid", problem: "trailing-data" } });
    const lone = concat([tarHeader("manifest.json", 0), new Uint8Array(512), new Uint8Array(512).fill(1)]);
    expect(await problem(lone)).toMatchObject({ detail: { reason: "tar-invalid", problem: "header" } });
  });

  it("stops reading the source when the reader gives up", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tarHeader("manifest.json", 4));
      },
      cancel() {
        cancelled = true;
      },
    });

    const reading = readTar(source, () => 3);
    await expect(reading.next()).rejects.toMatchObject({ detail: { problem: "size" } });
    expect(cancelled).toBe(true);
  });
});
