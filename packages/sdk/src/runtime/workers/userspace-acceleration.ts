import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { encodeAccelerationNotice, type LateFailure, type LateFailureNotice } from "../js-process/late-failure.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { readFileRecord } from "./userspace-files.js";
import { callUserspaceRecord } from "./userspace-record.js";
import { decodeAccelerationKnowledgeChanged, encodeAccelerationKnowledgeChanged } from "../js-process/runtime-probe.js";

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
  #pending = false;
  #writing: Promise<void> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(readonly storage: Store | undefined, readonly namespace: string, readonly binding: () => Binding | undefined,
    readonly failed: (error: VMError) => void = () => {}) {}

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

  /** Announces the notice, then persists the table. */
  async remember(notice: LateFailureNotice, failure: LateFailure): Promise<void> {
    const message = { version: PROTOCOL_VERSION, notice: encodeAccelerationNotice(notice, failure) };
    for (const port of this.#subscribers) port.postMessage(message);
    await this.persist();
  }

  /** Merges the stored file into Rust's table and writes the export: after a late failure, a
   * trial load's verdict or a runtime probe's (ADR 0026). */
  async persist(): Promise<void> {
    if (this.#closed) return;
    const binding = this.binding();
    this.#pending = true;
    try { if (binding !== undefined) this.#stored = exportTable(binding); }
    catch {
      this.failed(new VMError("PROTOCOL_ERROR", "Acceleration knowledge export failed"));
      this.#retryWrite(); return;
    }
    await this.#write();
  }

  /** Rust sets this notification for a trial verdict or runtime-probe result. */
  async poll(): Promise<void> {
    const binding = this.binding();
    if (binding === undefined || this.#closed) return;
    try {
      if (decodeAccelerationKnowledgeChanged(callUserspaceRecord(binding, "oxidevm_userspace_command", encodeAccelerationKnowledgeChanged()))) await this.persist();
    } catch (error) {
      this.failed(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "Acceleration knowledge polling failed"));
    }
  }

  async #write(): Promise<void> {
    const storage = this.storage;
    if (this.#closed || storage === undefined) return;
    if (this.#writing !== undefined) return this.#writing;
    this.#writing = this.#flush(storage).finally(() => { this.#writing = undefined; });
    await this.#writing;
  }

  async #flush(storage: Store): Promise<void> {
    try {
      while (this.#pending && !this.#closed) {
        this.#pending = false;
        const written = await navigator.locks.request(`oxidevm-acceleration-knowledge:${this.namespace}`, async () => {
          const stored = await storage.readAccelerationKnowledge(this.namespace);
          const binding = this.binding();
          if (binding === undefined || this.#closed) return false;
          const local = exportTable(binding);
          if (stored !== undefined) stage(binding, "oxidevm_userspace_acceleration_knowledge", stored);
          // Importing an older store must not replace this instance's newer verdicts.
          stage(binding, "oxidevm_userspace_acceleration_knowledge", local);
          const table = exportTable(binding);
          this.#stored = table;
          await storage.writeAccelerationKnowledge(this.namespace, table);
          return true;
        });
        if (!written) { this.#pending = true; this.#retryWrite(); return; }
      }
    } catch {
      this.#pending = true;
      this.failed(new VMError("STORAGE_ERROR", "Acceleration knowledge could not be persisted"));
      this.#retryWrite();
    }
  }

  #retryWrite(): void {
    if (!this.#closed && this.#retry === undefined) this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#write();
    }, 1_000);
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
    this.#closed = true;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    for (const port of this.#subscribers) port.close();
    this.#subscribers.clear();
  }
}

function exportTable(binding: Binding): Uint8Array<ArrayBuffer> {
  if (call(binding.instance, "oxidevm_userspace_acceleration_knowledge_export") !== 0) {
    throw new VMError("PROTOCOL_ERROR", "Acceleration knowledge export failed");
  }
  return readFileRecord(binding);
}

function stage(binding: Binding, name: string, bytes: Uint8Array): boolean {
  if (call(binding.instance, "oxidevm_userspace_staging_resize", bytes.byteLength) !== 0) return false;
  new Uint8Array(binding.memory.buffer, call(binding.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes);
  return call(binding.instance, name, bytes.byteLength) === 0;
}
