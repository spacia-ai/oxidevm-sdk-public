import { VMError } from "../errors.js";
import { SNAPSHOT_CHUNK_BYTES, type ChunkRef, type SnapshotStream } from "./snapshot-manifest.js";
import type { SnapshotObjects } from "./snapshot-objects.js";
import type { WorkspaceStreamInput } from "./workspace-stream.js";

/** Move existing durable streams into the snapshot object store with one chunk
 * of staging memory. The existing read lease retains the source generation. */
export async function captureFileStream(objects: SnapshotObjects, input: WorkspaceStreamInput, signal: AbortSignal): Promise<SnapshotStream> {
  const producer = input.source(signal);
  const chunks: ChunkRef[] = [];
  let received = 0;
  let used = 0;
  let buffer = new Uint8Array(Math.min(input.bytes, SNAPSHOT_CHUNK_BYTES));
  try {
    for await (const frame of producer.frames) {
      active(signal);
      if (frame.length === 0 || frame.length > 65536 || frame.length > input.bytes - received) invalid();
      received += frame.length;
      let offset = 0;
      while (offset < frame.length) {
        const take = Math.min(frame.length - offset, buffer.length - used);
        buffer.set(frame.subarray(offset, offset + take), used);
        offset += take; used += take;
        if (used === buffer.length) {
          chunks.push({ index: chunks.length, ...await objects.put(buffer) });
          buffer = new Uint8Array(Math.min(SNAPSHOT_CHUNK_BYTES, input.bytes - received + frame.length - offset));
          used = 0;
        }
      }
    }
    active(signal);
    if (received !== input.bytes || used !== 0) invalid();
    return { bytes: input.bytes, chunks };
  } finally { await producer.retire(); }
}

/** The same bounded producer contract WorkspaceStore already consumes. */
export function restoredFileStream(objects: Pick<SnapshotObjects, "read">, stream: SnapshotStream): WorkspaceStreamInput {
  return { bytes: stream.bytes, source: signal => {
    const frames = (async function* () {
      for (const ref of stream.chunks) {
        active(signal);
        const bytes = await objects.read(ref);
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          active(signal);
          yield bytes.slice(offset, offset + 65536);
        }
      }
    })();
    return { frames, retire: async () => { await frames.return(undefined); } };
  } };
}

function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native file transfer cancelled"); }
function invalid(): never { throw new VMError("STORAGE_ERROR", "Native file stream length is inconsistent"); }
