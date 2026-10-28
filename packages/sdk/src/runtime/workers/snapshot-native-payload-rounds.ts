import { VMError } from "../errors.js";
import { CheckpointChunkSink, CheckpointStreamReader, checkCheckpointHeader, checkpointHeader,
  decodeCheckpointDeclaration, encodeCheckpointDeclaration, type CheckpointInput, type CheckpointPayloadDeclaration } from "./userspace-checkpoint.js";
import { SNAPSHOT_CHUNK_BYTES, type ChunkRef, type ObjectRef, type SnapshotStream } from "./snapshot-manifest.js";
import type { SnapshotObjects, SnapshotReadLease } from "./snapshot-objects.js";

const MAX_STREAM = 16 * 1024 ** 3;
const MAX_OBJECTS = 8n * 1024n * 1024n;
interface Round { readonly data: StoredChunks; readonly index: StoredChunks; sealed: boolean }
interface IndexedPayload { readonly declaration: CheckpointPayloadDeclaration; readonly offset: number }

/** Temporary precopy state uses the snapshot CAS. Only chunk references, never guest pages,
 * are kept in JS; per-payload identities live in sorted binary index chunks. */
export class NativePayloadRounds {
  readonly #objects: SnapshotObjects;
  readonly #rounds: Round[] = [];
  readonly #live: StoredChunks;
  #baseline: Round | undefined;
  #liveSealed = false;
  constructor(objects: SnapshotObjects) { this.#objects = objects; this.#live = new StoredChunks(objects); }

  async setBaseline(stream: SnapshotStream, reads?: SnapshotReadLease): Promise<void> {
    if (this.#baseline !== undefined || this.#rounds.length !== 0 || this.#liveSealed) invalid("Native baseline must precede all payload rounds");
    const baseline = { data: new StoredChunks(this.#objects, stream, reads===undefined?undefined:ref=>reads.read(ref)), index: new StoredChunks(this.#objects), sealed: false };
    this.#baseline = baseline;
    await indexPayloads(baseline); baseline.sealed = true;
  }

  beginRound(ordinal: number): void {
    if (!Number.isInteger(ordinal) || ordinal !== this.#rounds.length || ordinal > 3 || this.#liveSealed || this.#baseline?.sealed === false || this.#rounds.some(round => !round.sealed)) invalid("Native payload round order is invalid");
    this.#rounds.push({ data: new StoredChunks(this.#objects), index: new StoredChunks(this.#objects), sealed: false });
  }
  async putRound(ordinal: number, index: number, data: Uint8Array): Promise<void> {
    const round = this.#round(ordinal);
    if (round.sealed) invalid("Native payload round is sealed");
    await round.data.put(index, data);
  }
  async sealRound(ordinal: number, bytes: number): Promise<void> {
    const round = this.#round(ordinal);
    if (round.sealed) invalid("Native payload round is sealed");
    round.data.seal(bytes);
    await indexPayloads(round); round.sealed = true;
  }
  async putLiveIndex(index: number, data: Uint8Array): Promise<void> {
    if (this.#liveSealed) invalid("Native live index is sealed");
    await this.#live.put(index, data);
  }
  async sealLiveIndex(bytes: number): Promise<void> {
    if (this.#liveSealed || this.#baseline?.sealed === false || this.#rounds.some(round => !round.sealed)) invalid("Native payload rounds are incomplete");
    this.#live.seal(bytes);
    const reader = this.#live.reader(), count = await readCount(reader, "OXUD", 24);
    if (BigInt(reader.remaining) !== count * 24n) invalid("Native live index length differs from its count");
    let previous = 0n;
    for (let index = 0n; index < count; index++) previous = decodeCheckpointDeclaration(await reader.read(24), previous).reference;
    await reader.finish(); this.#liveSealed = true;
  }
  async consolidate(sink: (index: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
    reuse?: (index: number, ref: ObjectRef) => Promise<void>): Promise<number> {
    if (!this.#liveSealed) invalid("Native live index is not sealed");
    const live = this.#live.reader(), count = await readCount(live, "OXUD", 24);
    const indexes = await Promise.all([...(this.#baseline === undefined ? [] : [this.#baseline]), ...this.#rounds].map(round => IndexCursor.open(round)));
    const writer = new CheckpointChunkSink("payloads", (_area, index, data) => sink(index, data));
    const header = checkpointHeader("OXUP", 16); new DataView(header.buffer).setBigUint64(8, count, true); await writer.write(header);
    let run: { readonly data: StoredChunks; readonly offset: number; bytes: number } | undefined;
    const flush = async (): Promise<void> => {
      if (run !== undefined) await run.data.copyTo(writer, run.offset, run.bytes, reuse);
    };
    let previous = 0n;
    for (let ordinal = 0n; ordinal < count; ordinal++) {
      const wanted = decodeCheckpointDeclaration(await live.read(24), previous); previous = wanted.reference;
      let selected: { cursor: IndexCursor; payload: IndexedPayload } | undefined;
      for (const cursor of indexes) {
        while (cursor.current !== undefined && cursor.current.declaration.reference < wanted.reference) await cursor.advance();
        if (cursor.current?.declaration.reference === wanted.reference) selected = { cursor, payload: cursor.current };
      }
      if (selected === undefined || selected.payload.declaration.kind !== wanted.kind || selected.payload.declaration.length !== wanted.length) invalid("Native final index names a missing or mismatched payload");
      const offset = selected.payload.offset - 24, bytes = 24 + Number(wanted.length);
      if (run?.data === selected.cursor.data && run.offset + run.bytes === offset) run.bytes += bytes;
      else {
        await flush();
        run = { data: selected.cursor.data, offset, bytes };
      }
    }
    await flush();
    await live.finish();
    // Older entries absent from the final graph are intentionally dropped, while their index
    // framing must still be complete and valid before publishing the consolidated stream.
    for (const cursor of indexes) while (cursor.current !== undefined) await cursor.advance();
    return writer.finish();
  }
  *objectRefs(): Iterable<string> {
    if (this.#baseline !== undefined) { yield* this.#baseline.data.objectRefs(); yield* this.#baseline.index.objectRefs(); }
    for (const round of this.#rounds) { yield* round.data.objectRefs(); yield* round.index.objectRefs(); }
    yield* this.#live.objectRefs();
  }
  #round(ordinal: number): Round {
    if (!Number.isInteger(ordinal) || ordinal < 0) invalid("Native payload round is invalid");
    const round = this.#rounds[ordinal]; if (round === undefined) invalid("Native payload round is not open"); return round;
  }
}

class StoredChunks {
  readonly #objects: SnapshotObjects; readonly #chunks: ChunkRef[] = []; #bytes = 0; #sealed = false; #writing = false;
  readonly #read:(ref:ObjectRef)=>Promise<Uint8Array<ArrayBuffer>>;
  #cached: { readonly index: number; readonly bytes: Uint8Array<ArrayBuffer> } | undefined;
  constructor(objects: SnapshotObjects, stream?: SnapshotStream, read:(ref:ObjectRef)=>Promise<Uint8Array<ArrayBuffer>>=ref=>objects.read(ref)) {
    this.#objects = objects;this.#read=read;
    if (stream !== undefined) {
      if (!Number.isSafeInteger(stream.bytes) || stream.bytes < 16 || stream.bytes > MAX_STREAM || stream.chunks.length !== Math.ceil(stream.bytes / SNAPSHOT_CHUNK_BYTES)) invalid("Native baseline stream length is invalid");
      for (const [index, chunk] of stream.chunks.entries()) {
        if (chunk.index !== index || chunk.bytes !== Math.min(SNAPSHOT_CHUNK_BYTES, stream.bytes - index * SNAPSHOT_CHUNK_BYTES)) invalid("Native baseline chunk is invalid");
        this.#chunks.push(chunk);
      }
      this.#bytes = stream.bytes; this.#sealed = true;
    }
  }
  get bytes(): number { return this.#bytes; }
  async put(index: number, data: Uint8Array): Promise<void> {
    if (this.#sealed || this.#writing || index !== this.#chunks.length || data.length === 0 || data.length > SNAPSHOT_CHUNK_BYTES || this.#bytes + data.length > MAX_STREAM
      || this.#chunks.length > 0 && this.#chunks.at(-1)?.bytes !== SNAPSHOT_CHUNK_BYTES) invalid("Native temporary stream chunk is invalid");
    this.#writing = true;
    try { const ref = await this.#objects.put(data); this.#chunks.push({ index, ...ref }); this.#bytes += data.length; }
    finally { this.#writing = false; }
  }
  seal(bytes: number): void {
    if (this.#sealed || this.#writing || bytes !== this.#bytes || !Number.isSafeInteger(bytes)) invalid("Native temporary stream length is invalid");
    this.#sealed = true;
  }
  *objectRefs(): Iterable<string> { for (const chunk of this.#chunks) yield chunk.sha256; }
  reader(): CheckpointStreamReader {
    if (!this.#sealed) invalid("Native temporary stream is not sealed");
    const chunks = this.#chunks, read = this.#read;
    const input: CheckpointInput = { bytes: this.#bytes, frames: (async function* () {
      for (const chunk of chunks) yield await read(chunk);
    })(), retire: () => Promise.resolve() };
    return new CheckpointStreamReader(input);
  }
  async *range(offset: number, length: number): AsyncGenerator<Uint8Array> {
    this.#checkRange(offset, length);
    while (length > 0) {
      const index = Math.floor(offset / SNAPSHOT_CHUNK_BYTES), within = offset % SNAPSHOT_CHUNK_BYTES;
      const ref = this.#chunks[index]; if (ref === undefined) invalid("Native payload range chunk is missing");
      if (this.#cached?.index !== index) this.#cached = { index, bytes: await this.#read(ref) };
      const chunk = this.#cached.bytes;
      let count = Math.min(length, chunk.length - within);
      for (let position = within; count > 0;) {
        const frame = Math.min(count, 65536); yield chunk.subarray(position, position + frame);
        position += frame; count -= frame; offset += frame; length -= frame;
      }
    }
  }
  async readAt(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(length); let copied = 0;
    for await (const frame of this.range(offset, length)) { output.set(frame, copied); copied += frame.length; }
    return output;
  }
  async copyTo(writer: CheckpointChunkSink, offset: number, length: number,
    reuse?: (index: number, ref: ObjectRef) => Promise<void>): Promise<void> {
    this.#checkRange(offset, length);
    while (length > 0) {
      const index = Math.floor(offset / SNAPSHOT_CHUNK_BYTES), within = offset % SNAPSHOT_CHUNK_BYTES;
      const ref = this.#chunks[index]; if (ref === undefined) invalid("Native payload range chunk is missing");
      const count = Math.min(length, ref.bytes - within);
      if (reuse !== undefined && within === 0 && count === SNAPSHOT_CHUNK_BYTES && writer.chunkOffset === 0) {
        await writer.forwardChunk(index => reuse(index, ref));
        offset += count; length -= count;
      } else {
        const batch: { readonly ref: ChunkRef; readonly within: number; readonly bytes: number }[] = [];
        let queued = 0;
        while (batch.length < 4 && queued < length) {
          const start = offset + queued, within = start % SNAPSHOT_CHUNK_BYTES;
          const ref = this.#chunks[Math.floor(start / SNAPSHOT_CHUNK_BYTES)];
          if (ref === undefined) invalid("Native payload range chunk is missing");
          const bytes = Math.min(length - queued, ref.bytes - within);
          if (queued !== 0 && reuse !== undefined && within === 0 && bytes === SNAPSHOT_CHUNK_BYTES
            && (writer.chunkOffset + queued) % SNAPSHOT_CHUNK_BYTES === 0) break;
          batch.push({ ref, within, bytes }); queued += bytes;
        }
        const reads = await Promise.allSettled(batch.map(async part => ({ ...part,
          data: this.#cached?.index === part.ref.index ? this.#cached.bytes : await this.#read(part.ref) })));
        for (const read of reads) if (read.status === "rejected") { const error: unknown = read.reason; throw error; }
        for (const read of reads) if (read.status === "fulfilled") {
          const { ref, within, bytes, data } = read.value;
          this.#cached = { index: ref.index, bytes: data };
          await writer.write(data.subarray(within, within + bytes)); offset += bytes; length -= bytes;
        }
      }
    }
  }
  #checkRange(offset: number, length: number): void {
    if (!this.#sealed || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > this.#bytes - offset) invalid("Native payload range is outside its stream");
  }
}

async function indexPayloads(round: Round): Promise<void> {
  const bytes = await round.data.readAt(0, 16); checkCheckpointHeader(bytes, "OXUP");
  const count = new DataView(bytes.buffer).getBigUint64(8, true);
  if (count > MAX_OBJECTS || count * 24n > BigInt(round.data.bytes - 16)) invalid("Native payload count is invalid");
  const writer = new CheckpointChunkSink("payloads", (_area, index, data) => round.index.put(index, data));
  const header = checkpointHeader("OXUI", 16); new DataView(header.buffer).setBigUint64(8, count, true); await writer.write(header);
  let previous = 0n, offset = 16;
  for (let index = 0n; index < count; index++) {
    const declaration = decodeCheckpointDeclaration(await round.data.readAt(offset, 24), previous); previous = declaration.reference; offset += 24;
    if (declaration.length > BigInt(round.data.bytes - offset)) invalid("Native payload exceeds its stream");
    const entry = new Uint8Array(32); entry.set(encodeCheckpointDeclaration(declaration));
    new DataView(entry.buffer).setBigUint64(24, BigInt(offset), true); await writer.write(entry);
    offset += Number(declaration.length);
  }
  if (offset !== round.data.bytes) invalid("Native payload stream has trailing bytes");
  round.index.seal(await writer.finish());
}
class IndexCursor {
  readonly data: StoredChunks; readonly #reader: CheckpointStreamReader;
  #remaining: bigint; #previous = 0n; current: IndexedPayload | undefined;
  private constructor(round: Round, reader: CheckpointStreamReader, count: bigint) { this.data = round.data; this.#reader = reader; this.#remaining = count; }
  static async open(round: Round): Promise<IndexCursor> {
    const reader = round.index.reader(), count = await readCount(reader, "OXUI", 32);
    if (BigInt(reader.remaining) !== count * 32n) invalid("Native round index length is invalid");
    const cursor = new IndexCursor(round, reader, count); await cursor.advance(); return cursor;
  }
  async advance(): Promise<void> {
    if (this.#remaining === 0n) { this.current = undefined; await this.#reader.finish(); return; }
    const entry = await this.#reader.read(32), declaration = decodeCheckpointDeclaration(entry.subarray(0, 24), this.#previous);
    const offset = new DataView(entry.buffer).getBigUint64(24, true);
    if (offset > BigInt(this.data.bytes) || declaration.length > BigInt(this.data.bytes) - offset) invalid("Native round index range is invalid");
    this.current = { declaration, offset: Number(offset) }; this.#previous = declaration.reference; this.#remaining--;
  }
}
async function readCount(reader: CheckpointStreamReader, magic: string, entryBytes: number): Promise<bigint> {
  const bytes = await reader.read(16); checkCheckpointHeader(bytes, magic);
  const count = new DataView(bytes.buffer).getBigUint64(8, true);
  if (count > MAX_OBJECTS || count * BigInt(entryBytes) > BigInt(reader.remaining)) invalid("Native payload index count is invalid");
  return count;
}
function invalid(message: string): never { throw new VMError("STORAGE_ERROR", message, { reason: "checkpoint-payload-invalid" }); }
