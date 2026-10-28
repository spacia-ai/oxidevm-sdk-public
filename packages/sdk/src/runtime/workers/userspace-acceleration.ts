import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { encodeAccelerationNotice, type LateFailure, type LateFailureNotice } from "../js-process/late-failure.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { readFileRecord } from "./userspace-files.js";

interface Binding { readonly instance: WebAssembly.Instance | Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory }
interface Store {
  readAccelerationKnowledge(namespace: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined>;
  writeAccelerationKnowledge(namespace: string, data: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void>;
}
const MAX_SUBSCRIBERS = 8;

/** ADR 0026: carries Rust's remembered-failure bytes between a runtime instance and the origin's
 * store. It decides nothing: Rust imports, records and exports the table. */
export class UserspaceAccelerationKnowledge {
  #stored: Uint8Array<ArrayBuffer> | undefined;
  readonly #subscribers = new Set<MessagePort>();

  constructor(readonly storage: Store | undefined, readonly namespace: string, readonly binding: () => Binding | undefined) {}

  get subscribers(): number { return this.#subscribers.size; }

  /** Reads the stored file once; an unreadable store starts empty. */
  async load(signal?: AbortSignal): Promise<void> {
    try { this.#stored = await this.storage?.readAccelerationKnowledge(this.namespace, signal); }
    catch { this.#stored = undefined; }
  }

  /** Before each acceleration enable: a new instance starts with an empty table. */
  importInto(binding: Binding): void {
    if (this.#stored !== undefined && !stage(binding, "oxidevm_userspace_acceleration_knowledge", this.#stored)) this.#stored = undefined;
  }

  /** Announces the notice, then merges the stored file into Rust's table and writes the export. */
  async remember(notice: LateFailureNotice, failure: LateFailure): Promise<void> {
    const message = { version: PROTOCOL_VERSION, notice: encodeAccelerationNotice(notice, failure) };
    for (const port of this.#subscribers) port.postMessage(message);
    const storage = this.storage;
    if (storage === undefined) return;
    try {
      await navigator.locks.request(`oxidevm-acceleration-knowledge:${this.namespace}`, async () => {
        const binding = this.binding();
        if (binding === undefined) return;
        const stored = await storage.readAccelerationKnowledge(this.namespace);
        if (stored !== undefined) stage(binding, "oxidevm_userspace_acceleration_knowledge", stored);
        if (call(binding.instance, "oxidevm_userspace_acceleration_knowledge_export") !== 0) return;
        const table = readFileRecord(binding);
        await storage.writeAccelerationKnowledge(this.namespace, table);
        this.#stored = table;
      });
    } catch { /* Persistence is best effort; this instance still remembers the program. */ }
  }

  /** A bounded push subscription for the page's diagnostics API. The page's only message is
   * its close; anything else closes the subscription too. */
  subscribe(): MessagePort {
    if (this.#subscribers.size >= MAX_SUBSCRIBERS) throw new VMError("QUOTA_EXCEEDED", "Too many acceleration notice subscriptions");
    const channel = new MessageChannel(), port = channel.port1;
    port.onmessage = () => { this.#subscribers.delete(port); port.close(); };
    this.#subscribers.add(port);
    return channel.port2;
  }

  close(): void {
    for (const port of this.#subscribers) port.close();
    this.#subscribers.clear();
  }
}

function stage(binding: Binding, name: string, bytes: Uint8Array): boolean {
  if (call(binding.instance, "oxidevm_userspace_staging_resize", bytes.byteLength) !== 0) return false;
  new Uint8Array(binding.memory.buffer, call(binding.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes);
  return call(binding.instance, name, bytes.byteLength) === 0;
}
