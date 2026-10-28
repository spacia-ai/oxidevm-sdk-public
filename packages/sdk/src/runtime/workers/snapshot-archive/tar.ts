import { VMError } from "../../errors.js";

const BLOCK_BYTES = 512;
const NAME_BYTES = 100;
/** The largest size an 11-digit octal size field holds. */
const MAX_SIZE = 0o77777777777;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_BYTES = 8;
const SIZE_OFFSET = 124;
const encoder = new TextEncoder();

/** A regular file of a tar archive, read whole. */
export interface TarFile {
  readonly name: string;
  readonly data: Uint8Array<ArrayBuffer>;
}

/** What is wrong with an archive a reader refused. */
export type TarProblem = "checksum" | "name" | "size" | "header" | "padding" | "truncated" | "trailing-data";

const PROBLEMS: Readonly<Record<TarProblem, string>> = {
  checksum: "a tar header's checksum does not match",
  name: "a tar entry's name is not a plain relative path",
  size: "a tar entry's size is invalid or too large",
  header: "a tar header sets fields a deterministic archive never sets",
  padding: "a tar entry's padding is not zero",
  truncated: "the archive ends early",
  "trailing-data": "the archive has data after its end",
};

/**
 * The header of a regular file in a deterministic ustar archive: mode 0644, uid and gid 0,
 * mtime 0, no owner names, link name or prefix. The same name and size always give the same bytes.
 */
export function tarHeader(name: string, size: number): Uint8Array<ArrayBuffer> {
  if (!plainName(name)) throw new VMError("INVALID_ARGUMENT", PROBLEMS.name);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) throw new VMError("INVALID_ARGUMENT", PROBLEMS.size);
  return canonicalHeader(name, size);
}

/** The zero bytes after `size` bytes of data, up to the next block. */
export function tarPadding(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array((BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES);
}

/** The end of an archive: two zero blocks. */
export function tarEnd(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(2 * BLOCK_BYTES);
}

/**
 * Reads a deterministic ustar archive from `source`, yielding each file whole. `maxBytes(name)`
 * bounds a file before any of it is read. Every header must be the canonical header of its name
 * and size, padding must be zero, and the archive must end with its end marker and nothing
 * after it. A refusal is INVALID_ARGUMENT with reason "tar-invalid" and the problem found; the
 * source is cancelled whenever reading stops before its end.
 */
export async function* readTar(
  source: ReadableStream<Uint8Array>,
  maxBytes: (name: string) => number,
): AsyncGenerator<TarFile, void, undefined> {
  const input = new TarInput(source.getReader());
  try {
    for (;;) {
      const header = await input.read(BLOCK_BYTES);
      if (isZero(header)) {
        if (!isZero(await input.read(BLOCK_BYTES))) refuse("header");
        if (!(await input.ended())) refuse("trailing-data");
        return;
      }
      const { name, size } = parseHeader(header);
      if (size > maxBytes(name)) refuse("size");
      const data = await input.read(size);
      if (!isZero(await input.read(tarPadding(size).byteLength))) refuse("padding");
      yield { name, data };
    }
  } finally {
    await input.close();
  }
}

function canonicalHeader(name: string, size: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(BLOCK_BYTES);
  header.set(encoder.encode(name), 0);
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), SIZE_OFFSET);
  header.set(encoder.encode("00000000000\0"), 136);
  header.set(encoder.encode("0"), 156);
  header.set(encoder.encode("ustar\x0000"), 257);
  header.set(encoder.encode(`${checksum(header).toString(8).padStart(6, "0")}\0 `), CHECKSUM_OFFSET);
  return header;
}

/** Checksum first, so a damaged byte reads as damage; then name, size, then every other field. */
function parseHeader(header: Uint8Array): { readonly name: string; readonly size: number } {
  const recorded = octal(header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + 6));
  if (recorded !== checksum(header) || header[CHECKSUM_OFFSET + 6] !== 0 || header[CHECKSUM_OFFSET + 7] !== 0x20) {
    refuse("checksum");
  }
  const name = parseName(header.subarray(0, NAME_BYTES));
  const size = octal(header.subarray(SIZE_OFFSET, SIZE_OFFSET + 11));
  if (size === undefined || header[SIZE_OFFSET + 11] !== 0) refuse("size");
  const canonical = canonicalHeader(name, size);
  if (canonical.some((byte, index) => byte !== header[index])) refuse("header");
  return { name, size };
}

/** The name before the first NUL as a plain relative ASCII path; what follows is checked as header. */
function parseName(field: Uint8Array): string {
  const end = field.indexOf(0);
  const length = end === -1 ? field.byteLength : end;
  let name = "";
  for (let index = 0; index < length; index += 1) name += String.fromCharCode(field[index] ?? 0);
  if (!plainName(name)) refuse("name");
  return name;
}

/** At most 100 visible ASCII characters in segments that are not empty, "." or "..". */
function plainName(name: string): boolean {
  if (name.length === 0 || name.length > NAME_BYTES || !/^[\x21-\x7e]+$/u.test(name) || name.includes("\\")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The value of ASCII octal digits, or undefined when a byte is not one. */
function octal(digits: Uint8Array): number | undefined {
  let value = 0;
  for (const byte of digits) {
    if (byte < 0x30 || byte > 0x37) return undefined;
    value = value * 8 + (byte - 0x30);
  }
  return value;
}

/** The sum of a header's bytes, its checksum field counted as spaces. */
function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK_BYTES; index += 1) {
    const inField = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_BYTES;
    sum += inField ? 0x20 : header[index] ?? 0;
  }
  return sum;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function refuse(problem: TarProblem): never {
  throw new VMError("INVALID_ARGUMENT", PROBLEMS[problem], { reason: "tar-invalid", problem });
}

/** The bytes of a stream, read in exact lengths however its chunks fall. */
class TarInput {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  /** How much of the first chunk is already read. */
  #offset = 0;
  #done = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  /** Exactly `length` bytes; a stream that ends first is a truncated archive. */
  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) {
        if (!(await this.#pull())) refuse("truncated");
        continue;
      }
      const taken = Math.min(length - filled, chunk.byteLength - this.#offset);
      bytes.set(chunk.subarray(this.#offset, this.#offset + taken), filled);
      filled += taken;
      this.#offset += taken;
      if (this.#offset === chunk.byteLength) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return bytes;
  }

  /** Whether the stream has no bytes left. */
  async ended(): Promise<boolean> {
    while (this.#chunks.length === 0) {
      if (!(await this.#pull())) return true;
    }
    return false;
  }

  /** Cancels a stream not read to its end, then lets go of it. */
  async close(): Promise<void> {
    if (!this.#done) await this.#reader.cancel().catch(() => undefined);
    this.#reader.releaseLock();
  }

  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    const { done, value } = await this.#reader.read();
    if (done) {
      this.#done = true;
      return false;
    }
    if (value.byteLength !== 0) this.#chunks.push(value);
    return true;
  }
}
