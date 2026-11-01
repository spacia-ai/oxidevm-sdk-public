import { VMError } from "../../runtime/errors.js";

/** The read side of a connection (a `Connection` has it); framing depends on nothing else. */
export interface FrameSource { read(maxBytes: number): Promise<Uint8Array> }
/** The write side of a connection. */
export interface FrameSink { write(bytes: Uint8Array): Promise<void> }

/** Stable `detail.reason` for a peer that breaks a length-prefixed protocol. */
export const FRAME_REASON = "wasm-module-frame";
const HEADER_BYTES = 4;

function frameError(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message, { reason: FRAME_REASON });
}

/** Reads exactly `size` bytes, or rejects when the stream ends first. */
export async function readExactly(connection: FrameSource, size: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(size) || size < 0) throw new VMError("INVALID_ARGUMENT", "A read size must be a non-negative safe integer");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const chunk = await connection.read(size - offset);
    if (chunk.length === 0) throw frameError("The connection closed before the data was complete");
    if (chunk.length > size - offset) throw frameError("The connection returned more bytes than requested");
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Reads one frame: a big-endian `u32` length, then that many bytes. The length is checked against
 * `maxBytes` before any payload is read, so a hostile peer cannot make the adapter allocate more.
 */
export async function readFrame(connection: FrameSource, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const header = await readExactly(connection, HEADER_BYTES);
  const length = new DataView(header.buffer).getUint32(0, false);
  if (length > maxBytes) throw frameError(`A frame of ${String(length)} bytes exceeds the limit of ${String(maxBytes)}`);
  return readExactly(connection, length);
}

/** Writes one frame (length header and payload in a single write). */
export async function writeFrame(connection: FrameSink, bytes: Uint8Array, maxBytes: number): Promise<void> {
  if (bytes.length > maxBytes || bytes.length > 0xffff_ffff) throw frameError(`A frame of ${String(bytes.length)} bytes exceeds the limit of ${String(maxBytes)}`);
  const frame = new Uint8Array(HEADER_BYTES + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, false);
  frame.set(bytes, HEADER_BYTES);
  await connection.write(frame);
}
