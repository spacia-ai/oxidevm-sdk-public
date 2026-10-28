import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";

// One slot per process. Closing is terminal; reuse requires a new generation
// and a fresh mailbox. This avoids stale replies racing a reused byte region.
const HEADER_BYTES = 16;
const CAPACITY = ASSISTANCE_LIMITS.request;
const IDLE = 0;
const REQUEST = 1;
const PROCESSING = 2;
const RESPONSE = 3;
const CLOSED = 4;

export function createMailbox(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
}

export function decodeMailbox(value: unknown): SharedArrayBuffer {
  if (!(value instanceof SharedArrayBuffer)) throw new TypeError("assistance mailbox must be shared memory");
  header(value);
  return value;
}

function header(buffer: SharedArrayBuffer): Int32Array<SharedArrayBuffer> {
  if (buffer.byteLength !== HEADER_BYTES + CAPACITY) {
    throw new RangeError("invalid assistance mailbox size");
  }
  return new Int32Array(buffer, 0, HEADER_BYTES / 4);
}

function checkSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffff_ffff) {
    throw new RangeError("invalid assistance mailbox sequence");
  }
}

function currentSequence(control: Int32Array): number {
  return Atomics.load(control, 1) >>> 0;
}

function checkBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > CAPACITY) throw new RangeError("assistance mailbox limit exceeded");
}

export function publishRequest(
  buffer: SharedArrayBuffer, sequence: number, bytes: Uint8Array,
): void {
  checkSequence(sequence);
  checkBytes(bytes);
  const control = header(buffer);
  if (Atomics.load(control, 0) !== IDLE) throw new Error("assistance mailbox is not idle");
  if (sequence <= currentSequence(control)) throw new Error("stale assistance request sequence");
  new Uint8Array(buffer, HEADER_BYTES, bytes.length).set(bytes);
  Atomics.store(control, 1, sequence);
  Atomics.store(control, 2, bytes.length);
  if (Atomics.compareExchange(control, 0, IDLE, REQUEST) !== IDLE) {
    throw new Error("assistance mailbox closed during publication");
  }
}

export function takeRequest(buffer: SharedArrayBuffer, sequence: number): Uint8Array {
  checkSequence(sequence);
  const control = header(buffer);
  if (currentSequence(control) !== sequence) throw new Error("stale assistance request sequence");
  if (Atomics.compareExchange(control, 0, REQUEST, PROCESSING) !== REQUEST) {
    throw new Error("assistance mailbox has no pending request");
  }
  // Treat producer-owned header and bytes as malicious. Only this bounded copy
  // may reach a decoder; never validate a path and later read it from the SAB.
  return copyPayload(buffer, control);
}

function copyPayload(buffer: SharedArrayBuffer, control: Int32Array): Uint8Array {
  const length = Atomics.load(control, 2);
  if (length < 0 || length > CAPACITY) throw new RangeError("invalid assistance mailbox length");
  return new Uint8Array(buffer, HEADER_BYTES, length).slice();
}

export function completeReply(
  buffer: SharedArrayBuffer, sequence: number, bytes: Uint8Array,
): boolean {
  checkSequence(sequence);
  checkBytes(bytes);
  const control = header(buffer);
  if (Atomics.load(control, 0) !== PROCESSING || currentSequence(control) !== sequence) return false;
  new Uint8Array(buffer, HEADER_BYTES, bytes.length).set(bytes);
  Atomics.store(control, 2, bytes.length);
  if (Atomics.compareExchange(control, 0, PROCESSING, RESPONSE) !== PROCESSING) return false;
  Atomics.notify(control, 0);
  return true;
}

/** Only call in a process worker. Its broker must run on a different worker. */
export function waitForReply(
  buffer: SharedArrayBuffer, sequence: number, timeoutMilliseconds: number | null,
): Uint8Array {
  checkSequence(sequence);
  if (timeoutMilliseconds !== null && (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0)) {
    throw new RangeError("invalid assistance deadline");
  }
  const control = header(buffer);
  const deadline = timeoutMilliseconds === null ? null : performance.now() + timeoutMilliseconds;
  for (;;) {
    const state = Atomics.load(control, 0);
    if (state === CLOSED) throw new Error("assistance mailbox closed");
    if (currentSequence(control) !== sequence) throw new Error("stale assistance reply sequence");
    if (state === RESPONSE) {
      const bytes = copyPayload(buffer, control);
      if (Atomics.compareExchange(control, 0, RESPONSE, IDLE) !== RESPONSE) {
        throw new Error("assistance mailbox closed during completion");
      }
      return bytes;
    }
    if (state !== REQUEST && state !== PROCESSING) throw new Error("invalid assistance mailbox state");
    const remaining = deadline === null ? undefined : deadline - performance.now();
    if ((remaining !== undefined && remaining <= 0) || Atomics.wait(control, 0, state, remaining) === "timed-out") {
      closeMailbox(buffer);
      throw new Error("assistance mailbox deadline exceeded");
    }
  }
}

export function closeMailbox(buffer: SharedArrayBuffer): void {
  const control = header(buffer);
  Atomics.store(control, 0, CLOSED);
  Atomics.notify(control, 0);
}
