import { bigint } from "../decode.ts";
import { VMError } from "../errors.ts";

export function decodeUndefined(value: unknown): undefined {
  if (value !== undefined) {
    throw new VMError("PROTOCOL_ERROR", "worker response must be undefined");
  }
  return undefined;
}

export function decodeBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new VMError("PROTOCOL_ERROR", "worker response must be bytes");
  }
  return value;
}

/**
 * A response received on a private worker port owns its cloned/transferred
 * fixed buffer. Reuse it without copying its contents. Shared or resizable
 * storage and partial views still need an independent, exact-sized snapshot.
 * Do not use this for request bytes retained by their caller.
 */
export function decodeOwnedResponseBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = decodeBytes(value);
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer && !buffer.resizable
    && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength
    ? new Uint8Array(buffer)
    : new Uint8Array(bytes);
}

export function finiteNonnegativeNumber(
  value: unknown,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new VMError(
      "PROTOCOL_ERROR",
      `${label} must be a finite nonnegative number`,
    );
  }
  return value;
}

export function nonnegativeBigint(value: unknown, label: string): bigint {
  const decoded = bigint(value, label);
  if (decoded < 0n) {
    throw new VMError("PROTOCOL_ERROR", `${label} must not be negative`);
  }
  return decoded;
}
