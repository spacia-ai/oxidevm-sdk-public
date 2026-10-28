import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import type { Readable } from "./node-streams.js";
import { streamError } from "./node-streams.js";

export type NativeFrame = { readonly tag: 0 | 1; readonly bytes: Buffer };

export function encodeNativeFrame(tag: 0 | 1, bytes: Uint8Array): Buffer {
  if (bytes.length === 0 || bytes.length > (tag === 0 ? 65536 : 16384)) throw invalid();
  const output = Buffer.allocUnsafe(bytes.length + 5); output[0] = tag;
  output.writeUInt32BE(bytes.length, 1); output.set(bytes, 5); return output;
}

/** The child Readable owns buffering and transport credit. Consume one bounded
 * data/control frame, preserving backpressure independently on both pipes. */
export async function readNativeFrame(stream: Readable): Promise<NativeFrame | null> {
  const header = await read(stream, 5); if (header === null) return null;
  const tag = header[0]; const length = header.readUInt32BE(1);
  if ((tag !== 0 && tag !== 1) || length === 0 || length > (tag === 0 ? 65536 : 16384)) throw invalid();
  const bytes = await read(stream, length); if (bytes === null) throw invalid();
  return { tag, bytes };
}
function read(stream: Readable, length: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { stream.removeListener("readable", available); stream.removeListener("end", available); stream.removeListener("error", failed); stream.removeListener("close", closed); };
    const failed = (error: unknown) => { cleanup(); reject(streamError(error)); };
    const available = () => {
      try {
        const value = stream.read(length);
        if (value !== null) {
          cleanup();
          if (!(value instanceof Uint8Array) || value.length !== length) { reject(invalid()); return; }
          resolve(Buffer.from(value));
        } else if (stream.readableEnded) { cleanup(); resolve(null); }
      } catch (error) { failed(error); }
    };
    const closed = () => { if (stream.readableEnded) available(); else failed(invalid()); };
    stream.on("readable", available); stream.once("end", available); stream.once("error", failed); stream.once("close", closed);
    available();
    if (stream.destroyed && !stream.readableEnded) failed(invalid());
  });
}

function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native helper frame"); }
