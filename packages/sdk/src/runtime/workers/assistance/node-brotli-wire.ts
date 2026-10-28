import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { Readable } from "./node-streams.js";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.js";

export type BrotliOperation = 0 | 1 | 2 | 3;
export type BrotliControl = { readonly kind: "end" } | { readonly kind: "flush"; readonly operation: BrotliOperation };
export type BrotliFrame = { readonly kind: "data"; readonly bytes: Buffer }
  | { readonly kind: "ready" | "end" }
  | { readonly kind: "flushed" | "finished"; readonly outputBytes: number }
  | { readonly kind: "written"; readonly count: number; readonly outputBytes: number }
  | { readonly kind: "error"; readonly code: string; readonly message: string; readonly errno?: number }
  | { readonly kind: "close"; readonly hadError: boolean };

export function brotliControl(value: BrotliControl): Buffer { return encodeNativeFrame(1, Buffer.from(JSON.stringify(value))); }
export function brotliData(value: Uint8Array): Buffer { return encodeNativeFrame(0, value); }

export async function readBrotliFrame(stream: Readable): Promise<BrotliFrame | null> {
  const frame = await readNativeFrame(stream); if (frame === null) return null;
  if (frame.tag === 0) return { kind: "data", bytes: frame.bytes };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes)); } catch { throw invalid(); }
  const input = record(value, "Brotli helper event"); const kind = input["kind"];
  if (kind === "ready" || kind === "end") { exactKeys(input, ["kind"]); return { kind }; }
  if (kind === "flushed" || kind === "finished") {
    exactKeys(input, ["kind", "outputBytes"]); return { kind, outputBytes: integer(input["outputBytes"], "Brotli output bytes", 0, Number.MAX_SAFE_INTEGER) };
  }
  if (kind === "written") {
    exactKeys(input, ["kind", "count", "outputBytes"]);
    return { kind, count: integer(input["count"], "Brotli write count", 1, 65536), outputBytes: integer(input["outputBytes"], "Brotli output bytes", 0, Number.MAX_SAFE_INTEGER) };
  }
  if (kind === "close") {
    exactKeys(input, ["kind", "hadError"]);
    if (typeof input["hadError"] !== "boolean") throw invalid();
    return { kind, hadError: input["hadError"] };
  }
  if (kind === "error") {
    exactKeys(input, ["kind", "code", "message"], ["errno"]);
    return { kind, code: text(input["code"], 128), message: text(input["message"], 8192),
      ...(input["errno"] === undefined ? {} : { errno: integer(input["errno"], "Brotli errno", -0x8000_0000, 0x7fff_ffff) }) };
  }
  throw invalid();
}

function text(value: unknown, maximum: number): string {
  const result = string(value, "Brotli text"); if (Buffer.byteLength(result) > maximum || result.includes("\0")) throw invalid(); return result;
}
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native Brotli frame"); }
