import type { CheckpointRaw } from "./raw.js";
import { active, checkHeader, ChunkSink, header, invalid, type CheckpointSink } from "./stream.js";
import { decodeCheckpointDeclaration, encodeCheckpointDeclaration, type CheckpointPayloadDeclaration } from "./framing.js";

export class CaptureFrames {
  readonly #raw: CheckpointRaw; readonly #token: bigint; readonly #round: number | undefined;
  constructor(raw: CheckpointRaw, token: bigint, round?: number) { this.#raw = raw; this.#token = token; this.#round = round; }
  async graph(sink: CheckpointSink, signal?: AbortSignal): Promise<number> {
    const count = this.#raw.u32("metadata_count", this.#token);
    if (count < 2 || count > 4097) invalid("Native checkpoint metadata count is invalid");
    const output = new ChunkSink("graph", sink, signal), envelope = header("OXUG", 12);
    new DataView(envelope.buffer).setUint32(8, count, true); await output.write(envelope);
    for (let index = 0; index < count; index++) {
      active(signal); this.#raw.ok("metadata_read", this.#token, index);
      const bytes = this.#raw.frame();
      if (bytes.length === 0 || index === 0 && bytes.length !== 49) invalid("Native checkpoint metadata frame is invalid");
      if (index < 2) checkHeader(bytes, index === 0 ? "OXWA" : "OXUC");
      const framing = new Uint8Array(8), view = new DataView(framing.buffer);
      view.setUint32(0, index, true); view.setUint32(4, bytes.length, true);
      await output.write(framing); await output.write(bytes);
    }
    return output.finish();
  }
  *#declarations(full = false): Generator<CheckpointPayloadDeclaration> {
    let after = 0n;
    for (;;) {
      if (this.#round === undefined || full) this.#raw.ok("payload_declarations", this.#token, after);
      else this.#raw.ok("precopy_round_declarations", this.#token, this.#round, after);
      const bytes = this.#raw.frame();
      if (bytes.length === 0) return;
      if (bytes.length % 24 !== 0) invalid("Native checkpoint declarations are malformed");
      for (let offset = 0; offset < bytes.length; offset += 24) {
        const declaration = decodeCheckpointDeclaration(bytes.subarray(offset, offset + 24), after);
        after = declaration.reference; yield declaration;
      }
    }
  }
  async payloads(sink: CheckpointSink, signal?: AbortSignal): Promise<number> {
    let count = 0n, bytes = 16n;
    for (const declaration of this.#declarations()) {
      active(signal); count++; bytes += 24n + declaration.length;
      if (count > 8n * 1024n * 1024n || bytes > 16n * 1024n * 1024n * 1024n) invalid("Native checkpoint payload stream exceeds its limit");
    }
    const output = new ChunkSink("payloads", sink, signal), envelope = header("OXUP", 16);
    new DataView(envelope.buffer).setBigUint64(8, count, true); await output.write(envelope);
    for (const declaration of this.#declarations()) {
      active(signal);
      await output.write(encodeCheckpointDeclaration(declaration));
      for (let offset = 0n; offset < declaration.length;) {
        active(signal);
        if (this.#round === undefined) this.#raw.ok("payload_read", this.#token, declaration.reference, offset);
        else this.#raw.ok("precopy_payload_read", this.#token, this.#round, declaration.reference, offset);
        const bytes = this.#raw.frame();
        if (bytes.length === 0 || BigInt(bytes.length) > declaration.length - offset) invalid("Native checkpoint payload frame is invalid");
        await output.write(bytes); offset += BigInt(bytes.length);
      }
    }
    return output.finish();
  }
  async liveIndex(sink: (index: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>, signal?: AbortSignal): Promise<number> {
    let count = 0n;
    for (const declaration of this.#declarations(true)) { active(signal); count++; if (count > 8n * 1024n * 1024n || declaration.length > 1024n ** 3n) invalid("Native live index exceeds its limit"); }
    const output = new ChunkSink("payloads", (_area, index, bytes) => sink(index, bytes), signal), envelope = header("OXUD", 16);
    new DataView(envelope.buffer).setBigUint64(8, count, true); await output.write(envelope);
    for (const declaration of this.#declarations(true)) await output.write(encodeCheckpointDeclaration(declaration));
    return output.finish();
  }
}
