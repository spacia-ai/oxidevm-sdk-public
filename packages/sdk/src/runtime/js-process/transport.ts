import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { postCounted, type AttentionCounter } from "../host-attention.js";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION, jsMailboxAttention, LinuxError, Reader, Writer, copyBytes, viewBytes, type LinuxOperation, type LinuxResult, protocol } from "./codec.js";

const Uint8Array = globalThis.Uint8Array;

interface Pending { resolve(result: LinuxResult): void; reject(error: Error): void; readonly cleanup: () => void }
interface Queued extends Pending { readonly operation: { readonly number: number; readonly payload: Uint8Array }; sequence?: number }
const WAKE_OPERATIONS = new Set([1, 3, 48, 62, 255, 65541, 65542, 65544]);
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** A worker owns transport promises. Rust owns all pending Linux operations. */
export class LinuxClient {
  readonly #header: Int32Array;
  readonly #body: Uint8Array;
  readonly #attention: AttentionCounter;
  readonly #pending = new Map<number, Pending>();
  readonly #cancellations = new Set<number>();
  readonly #queue: Queued[] = [];
  #queuedBytes = 0;
  #cancelling = false;
  #sequence = 0;
  #closed = false;
  constructor(readonly port: MessagePort, mailbox: SharedArrayBuffer) {
    if (mailbox.byteLength !== JS_MAILBOX_BYTES) protocol("Invalid Linux mailbox size");
    this.#header = new Int32Array(mailbox, 0, 4); this.#body = new Uint8Array(mailbox, 16); this.#attention = jsMailboxAttention(mailbox);
    port.onmessage = event => { try { this.#receive(event.data); } catch (error) { this.dispose(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Linux reply failed")); } };
    port.onmessageerror = () => this.dispose(new VMError("PROTOCOL_ERROR", "Linux reply could not be decoded"));
    port.start();
  }
  #next(): number { if (this.#closed) throw new VMError("ABORTED", "JS process transport is closed"); const sequence = integer(this.#sequence + 1, "Linux request sequence", 1, 0x7fff_ffff); this.#sequence = sequence; return sequence; }
  sync<T>(operation: LinuxOperation<T>): T {
    const sequence = this.#next(); Atomics.store(this.#header, 0, 0);
    postCounted(this.#attention, () => { this.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence, sync: true, operation: operation.number, payload: operation.payload }); });
    // A stopped Linux process can wait indefinitely. Rust termination kills this worker.
    while (Atomics.load(this.#header, 0) === 0) Atomics.wait(this.#header, 0, 0);
    if (Atomics.load(this.#header, 2) !== sequence) protocol("Linux mailbox sequence mismatch");
    const length = integer(Atomics.load(this.#header, 1), "Linux mailbox length", 12, this.#body.byteLength);
    const bytes = copyBytes(this.#body, 0, length), reader = new Reader(bytes);
    const errno = reader.u32();
    if (errno !== 0) throw new LinuxError(errno);
    return operation.decode({ value: reader.u64(), bytes: viewBytes(bytes, 12) });
  }
  async call<T>(operation: LinuxOperation<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new VMError("ABORTED", "Linux operation was aborted before admission");
    if (this.#closed) throw new VMError("ABORTED", "JS process transport is closed");
    if (this.#queue.length >= 512 || this.#queuedBytes + operation.payload.byteLength > MAX_QUEUED_BYTES) throw new VMError("QUOTA_EXCEEDED", "JS process transport queue is full");
    const result = await new Promise<LinuxResult>((resolve, reject) => {
      const cancel = () => {
        if (entry.sequence === undefined) {
          const index = this.#queue.indexOf(entry); if (index < 0) return;
          this.#queue.splice(index, 1); this.#queuedBytes -= entry.operation.payload.byteLength; entry.cleanup();
          reject(signal?.reason instanceof Error ? signal.reason : new VMError("ABORTED", "Linux operation was aborted before admission"));
        } else { this.#cancellations.add(entry.sequence); this.#drainCancellation(); }
      };
      const entry: Queued = { resolve, reject, operation: { number: operation.number, payload: copyBytes(operation.payload) }, cleanup: () => signal?.removeEventListener("abort", cancel) };
      this.#queue.push(entry); this.#queuedBytes += entry.operation.payload.byteLength;
      signal?.addEventListener("abort", cancel, { once: true });
      this.#flush();
    });
    return operation.decode(result);
  }
  #flush(): void {
    while (!this.#closed) {
      const index = this.#queue.findIndex(entry => this.#pending.size < 32 || this.#pending.size < (entry.operation.number === 65539 ? 35 : 34) && (entry.operation.number === 65539 || WAKE_OPERATIONS.has(entry.operation.number)));
      if (index < 0) return;
      const entry = this.#queue.splice(index, 1)[0]; if (entry === undefined) protocol("Missing queued Linux request");
      this.#queuedBytes -= entry.operation.payload.byteLength;
      const sequence = this.#next(); entry.sequence = sequence; this.#pending.set(sequence, entry);
      try { postCounted(this.#attention, () => { this.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence, sync: false, operation: entry.operation.number, payload: entry.operation.payload }); }); }
      catch (error) { this.dispose(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Linux request delivery failed")); }
    }
  }
  #drainCancellation(): void {
    if (this.#closed || this.#cancelling || this.#pending.size >= 35) return;
    const sequence = this.#cancellations.values().next().value;
    if (sequence === undefined) return;
    this.#cancellations.delete(sequence); this.#cancelling = true;
    const target = new Writer().u64(sequence).finish();
    const finished = () => { this.#cancelling = false; this.#drainCancellation(); };
    // One control request at a time preserves reserved capacity for shared-signal aborts.
    void this.call({ number: 65539, payload: target, decode: () => undefined }).then(finished, (error: unknown) => {
      this.dispose(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Linux cancellation failed")); finished();
    });
  }
  #receive(input: unknown): void {
    const reply = record(input, "Linux reply"); exactKeys(reply, ["version", "type", "sequence", "errno", "value", "payload"]);
    if (reply["version"] !== JS_PROCESS_PROTOCOL_VERSION || reply["type"] !== "reply" || typeof reply["value"] !== "bigint" || !(reply["payload"] instanceof Uint8Array) || reply["payload"].byteLength > this.#body.byteLength) protocol("Malformed Linux reply");
    const sequence = integer(reply["sequence"], "Linux reply sequence", 1), errno = integer(reply["errno"], "Linux errno", 0, 4095);
    const pending = this.#pending.get(sequence); if (pending === undefined) protocol("Unexpected Linux completion");
    this.#pending.delete(sequence); this.#cancellations.delete(sequence); pending.cleanup();
    if (errno !== 0) pending.reject(new LinuxError(errno));
    else pending.resolve({ value: reply["value"], bytes: reply["payload"] });
    this.#drainCancellation();
    this.#flush();
  }
  dispose(error: Error = new VMError("ABORTED", "JS process transport closed")): void { if (this.#closed) return; this.#closed = true; for (const pending of [...this.#pending.values(), ...this.#queue]) { pending.cleanup(); pending.reject(error); } this.#pending.clear(); this.#queue.length = 0; this.#queuedBytes = 0; this.#cancellations.clear(); this.port.close(); }
}
