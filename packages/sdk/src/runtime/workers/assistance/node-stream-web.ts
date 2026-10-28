import { VMError } from "../../errors.ts";

/** Node's `stream/web` export names; each is the platform's own class, which
 * the isolated process worker already provides as a global. */
export const NODE_STREAM_WEB_EXPORTS = [
  "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest",
  "ReadableByteStreamController", "ReadableStreamDefaultController", "TransformStream", "TransformStreamDefaultController",
  "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "ByteLengthQueuingStrategy",
  "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream",
] as const;

/** The `stream/web` builtin: Node re-exports the WHATWG classes, and so does
 * the assisted runtime, from the worker's globals. A platform missing one is
 * refused as a whole so a package never sees a partial module. */
export function createNodeStreamWeb(globals: unknown): Readonly<Record<string, unknown>> {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "stream/web requires the platform's global scope");
  const module: Record<string, unknown> = {};
  for (const name of NODE_STREAM_WEB_EXPORTS) {
    const value: unknown = Reflect.get(globals, name);
    if (typeof value !== "function") {
      throw new VMError("FEATURE_NOT_AVAILABLE", `stream/web is unavailable: the platform lacks ${name}`, { builtin: "stream/web", missing: name });
    }
    module[name] = value;
  }
  return Object.freeze(module);
}
