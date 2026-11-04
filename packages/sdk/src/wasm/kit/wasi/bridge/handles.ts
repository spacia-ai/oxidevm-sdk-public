import { WASI } from "../errno.js";
import { WasiError } from "../context.js";
import type { DescriptorTable } from "../descriptors.js";

/**
 * Bridge handles of one run (retained command results, open connections). They share the run's 256-entry budget with
 * the WASI descriptor table; a handle number is never reused while the run lasts, so a stale one is BADF.
 */
export class Handles<T> {
  readonly #items = new Map<number, T>();
  #next = 1;
  constructor(readonly table: DescriptorTable, readonly others: () => number, readonly limit = 256) {}
  get size(): number { return this.#items.size; }
  add(item: T): number {
    if (this.table.size + this.others() + this.#items.size >= this.limit) throw new WasiError(WASI.mfile);
    const handle = this.#next++;
    this.#items.set(handle, item);
    return handle;
  }
  get(handle: number): T { const item = this.#items.get(handle); if (item === undefined) throw new WasiError(WASI.badf); return item; }
  remove(handle: number): T { const item = this.get(handle); this.#items.delete(handle); return item; }
  values(): IterableIterator<T> { return this.#items.values(); }
}
