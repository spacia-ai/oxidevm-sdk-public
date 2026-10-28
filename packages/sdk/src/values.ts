import { VMError } from "./runtime/errors.js";

export type RuntimeMode = "system" | "userspace";
export type ImagePreparation = "on-demand" | "before-ready";
export type CPUProfile = "x86-64-v2" | "x86-64-v3";

declare const sha256Brand: unique symbol;
declare const processIdBrand: unique symbol;
export type SHA256 = string & { readonly [sha256Brand]: true };
export type ProcessId = number & { readonly [processIdBrand]: true };

export function decodeSHA256(value: unknown, field: string): SHA256 {
  if (!isSHA256(value)) {
    throw new VMError("INVALID_ARGUMENT", `${field} must be lowercase 64-digit SHA-256 hex`, { field });
  }
  return value;
}

export function decodeProcessId(value: unknown): ProcessId {
  if (!isProcessId(value)) throw new VMError("PROTOCOL_ERROR", "Process ID must be a positive bounded integer");
  return value;
}

function isSHA256(value: unknown): value is SHA256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isProcessId(value: unknown): value is ProcessId {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fff_ffff;
}
