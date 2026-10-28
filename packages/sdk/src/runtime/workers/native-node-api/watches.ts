import type { FileDescriptor } from "../../../js-process-types.js";
import { VMError } from "../../errors.js";
import { descriptor, LinuxError, noValue, operation, protocol, value, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import type { LinuxClient } from "../../js-process/transport.js";
import { decodeWatchEvents } from "../../protocol/assistance-watch.js";

/** Adapts Node subscriptions to one Rust-owned inotify descriptor per environment. */
export class NativeFileWatches {
  #fd: FileDescriptor | undefined;
  readonly #references = new Map<number, number>();
  #sequence = 0n;
  constructor(readonly client: Pick<LinuxClient, "sync">) {}

  add(path: string) {
    if (this.#references.size >= 8192) throw new VMError("QUOTA_EXCEEDED", "Native watcher subscription limit exceeded");
    const fd = this.#fd ??= this.client.sync(operation(294, new Writer().u64(0o2000000), result => descriptor(value(result))));
    const watch = this.client.sync(operation(254, new Writer().u64(fd).path(path).u32(0xfc6), result => {
      const wd = value(result); if (wd < 1 || wd > 0x7fff_ffff || result.bytes.length !== 0) protocol("Invalid Linux watch identity"); return wd;
    }));
    this.#references.set(watch, (this.#references.get(watch) ?? 0) + 1);
    return { kind: "watch-opened", watch } as const;
  }
  remove(watch: number) {
    const references = this.#references.get(watch);
    if (this.#fd === undefined || references === undefined || references === 0) throw new LinuxError(22);
    if (references === 1) this.client.sync(operation(255, new Writer().u64(this.#fd).u32(watch), noValue));
    // Keep the tombstone until Rust delivers IN_IGNORED to an outstanding reader.
    this.#references.set(watch, references - 1);
    return { kind: "unit" } as const;
  }
  read() {
    if (this.#fd === undefined) throw new LinuxError(9);
    const request = files.read(this.#fd, 4096);
    return { ...request, decode: (result: Parameters<typeof request.decode>[0]) => {
      const bytes = request.decode(result), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const events = [];
      for (let offset = 0; offset < bytes.length;) {
        if (offset + 16 > bytes.length) protocol("Truncated Linux inotify event");
        const watch = view.getInt32(offset, true), mask = view.getUint32(offset + 4, true), cookie = view.getUint32(offset + 8, true), length = view.getUint32(offset + 12, true);
        if (length > 256 || length % 16 !== 0 || offset + 16 + length > bytes.length) protocol("Invalid Linux inotify name length");
        const end = length === 0 ? offset + 16 : bytes.indexOf(0, offset + 16);
        if (end < offset + 16 || end >= offset + 16 + length && length !== 0 || bytes.subarray(end, offset + 16 + length).some(byte => byte !== 0)) protocol("Invalid Linux inotify name padding");
        const change = mask & 0x4000 ? "overflow" : mask & 0xa000 ? "retired" : mask & 6 ? "change" : "rename";
        events.push({ sequence: ++this.#sequence, watch: watch === -1 ? null : watch, mask, cookie, change, name: length === 0 ? null : new Uint8Array(bytes.subarray(offset + 16, end)) });
        offset += 16 + length;
      }
      const checked = decodeWatchEvents(events);
      for (const event of checked) if (event.change === "retired" && event.watch !== null) this.#references.delete(event.watch);
      return { kind: "watch-events", events: checked } as const;
    } };
  }
}
