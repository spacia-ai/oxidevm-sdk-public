import { VMError } from "./errors.ts";

const isSafeInteger = Number.isSafeInteger;
const minimumInteger = Number.MIN_SAFE_INTEGER, maximumInteger = Number.MAX_SAFE_INTEGER;

export function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw protocolError(`${label} must be an object`);
  }
  return value;
}

export function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw protocolError(`missing protocol field ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw protocolError(`unexpected protocol field ${key}`);
    }
  }
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw protocolError(`${label} must be a string`);
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError(`${label} must be a boolean`);
  }
  return value;
}

export function integer(
  value: unknown,
  label: string,
  minimum = minimumInteger,
  maximum = maximumInteger,
): number {
  if (
    typeof value !== "number" ||
    !isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw protocolError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function bigint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") {
    throw protocolError(`${label} must be a bigint`);
  }
  return value;
}

export function protocolError(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
