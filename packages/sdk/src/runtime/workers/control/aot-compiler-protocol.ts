import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";

export const AOT_COMPILER_PROTOCOL_VERSION = 1;

export interface AotCompilerRequest {
  readonly version: typeof AOT_COMPILER_PROTOCOL_VERSION;
  readonly type: "compile";
  readonly id: number;
  readonly runtimeEpoch: number;
  readonly catalogGeneration: bigint;
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly memberCount: number;
}

export type AotCompilerResponse =
  | {
      readonly version: typeof AOT_COMPILER_PROTOCOL_VERSION;
      readonly type: "compiled";
      readonly id: number;
      readonly runtimeEpoch: number;
      readonly catalogGeneration: bigint;
      readonly sha256: string;
      readonly module: WebAssembly.Module;
      readonly fetchMilliseconds: number;
      readonly hashMilliseconds: number;
      readonly compileMilliseconds: number;
    }
  | {
      readonly version: typeof AOT_COMPILER_PROTOCOL_VERSION;
      readonly type: "failed";
      readonly id: number;
      readonly runtimeEpoch: number;
      readonly catalogGeneration: bigint;
      readonly sha256: string;
      readonly reason: string;
    };

export function decodeAotCompilerRequest(value: unknown): AotCompilerRequest {
  const message = record(value, "AOT compiler request");
  exactKeys(message, [
    "version", "type", "id", "runtimeEpoch", "catalogGeneration", "url",
    "byteLength", "sha256", "sourceSha256", "memberCount",
  ]);
  if (
    integer(message["version"], "AOT compiler protocol") !== AOT_COMPILER_PROTOCOL_VERSION
    || string(message["type"], "AOT compiler request type") !== "compile"
  ) throw protocol("AOT compiler request version or type is invalid");
  return {
    version: AOT_COMPILER_PROTOCOL_VERSION,
    type: "compile",
    id: integer(message["id"], "AOT compiler request ID", 1),
    runtimeEpoch: integer(message["runtimeEpoch"], "AOT runtime epoch", 1),
    catalogGeneration: positiveBigint(message["catalogGeneration"], "AOT catalog generation"),
    url: httpUrl(message["url"]),
    byteLength: integer(message["byteLength"], "AOT pack bytes", 1, 4 * 1024 * 1024),
    sha256: digest(message["sha256"], "AOT pack digest"),
    sourceSha256: digest(message["sourceSha256"], "AOT source digest"),
    memberCount: integer(message["memberCount"], "AOT pack members", 1, 256),
  };
}

export function decodeAotCompilerResponse(value: unknown): AotCompilerResponse {
  const message = record(value, "AOT compiler response");
  const type = string(message["type"], "AOT compiler response type");
  const common = decodeResponseCommon(message);
  if (type === "failed") {
    exactKeys(message, [
      "version", "type", "id", "runtimeEpoch", "catalogGeneration", "sha256",
      "reason",
    ]);
    return {
      ...common,
      type,
      reason: string(message["reason"], "AOT compiler failure"),
    };
  }
  if (type !== "compiled") throw protocol("AOT compiler response type is invalid");
  exactKeys(message, [
    "version", "type", "id", "runtimeEpoch", "catalogGeneration", "sha256",
    "module", "fetchMilliseconds", "hashMilliseconds", "compileMilliseconds",
  ]);
  if (!(message["module"] instanceof WebAssembly.Module)) {
    throw protocol("AOT compiler response module is invalid");
  }
  return {
    ...common,
    type,
    module: message["module"],
    fetchMilliseconds: finiteDuration(message["fetchMilliseconds"], "AOT fetch time"),
    hashMilliseconds: finiteDuration(message["hashMilliseconds"], "AOT hash time"),
    compileMilliseconds: finiteDuration(message["compileMilliseconds"], "AOT compile time"),
  };
}

function decodeResponseCommon(message: Readonly<Record<string, unknown>>) {
  if (integer(message["version"], "AOT compiler protocol") !== AOT_COMPILER_PROTOCOL_VERSION) {
    throw protocol("AOT compiler response version is invalid");
  }
  return {
    version: AOT_COMPILER_PROTOCOL_VERSION,
    id: integer(message["id"], "AOT compiler response ID", 1),
    runtimeEpoch: integer(message["runtimeEpoch"], "AOT runtime epoch", 1),
    catalogGeneration: positiveBigint(message["catalogGeneration"], "AOT catalog generation"),
    sha256: digest(message["sha256"], "AOT pack digest"),
  } as const;
}

function digest(value: unknown, name: string): string {
  const decoded = string(value, name);
  if (!/^[0-9a-f]{64}$/u.test(decoded)) throw protocol(`${name} is invalid`);
  return decoded;
}

function positiveBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 1n || value > 0xffff_ffff_ffff_ffffn) {
    throw protocol(`${name} is invalid`);
  }
  return value;
}

function finiteDuration(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocol(`${name} is invalid`);
  }
  return value;
}

function httpUrl(value: unknown): string {
  const raw = string(value, "AOT pack URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw protocol("AOT pack URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw protocol("AOT pack URL must use HTTP(S)");
  }
  return parsed.href;
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
