export type CoreAbiErrorCode =
  | "SNAPSHOT_VERSION"
  | "UNSUPPORTED_INSTRUCTION"
  | "UNSUPPORTED_SYSCALL"
  | "VM_FAULT";

export class CoreAbiError extends Error {
  readonly code: CoreAbiErrorCode;

  constructor(code: CoreAbiErrorCode, message: string) {
    super(message);
    this.name = "CoreAbiError";
    this.code = code;
  }
}

/** Bytes of the magic, version, reserved and payload-length header every core record starts with. */
export const RECORD_HEADER_LENGTH = 12;

export function fault(message: string): CoreAbiError {
  return new CoreAbiError("VM_FAULT", message);
}

export class BinaryCursor {
  readonly #view: DataView;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    this.#offset = offset;
  }

  u8(): number {
    this.#require(1);
    return this.#view.getUint8(this.#offset++);
  }

  u16(): number {
    this.#require(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  u64(): bigint {
    this.#require(8);
    const value = this.#view.getBigUint64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  zero(length: number, field: string): void {
    for (let index = 0; index < length; index += 1) {
      if (this.u8() !== 0) throw fault(`${field} must be zero`);
    }
  }

  finish(record: string): void {
    if (this.#offset !== this.#view.byteLength) {
      throw fault(`${record} has trailing data`);
    }
  }

  #require(length: number): void {
    if (this.#offset + length > this.#view.byteLength) {
      throw fault("truncated core record");
    }
  }
}

export function expectMagic(cursor: BinaryCursor, expected: string): void {
  for (let index = 0; index < expected.length; index += 1) {
    if (cursor.u8() !== expected.charCodeAt(index)) {
      throw fault("invalid core record magic");
    }
  }
}
