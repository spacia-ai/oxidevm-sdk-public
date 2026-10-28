import { boolean, exactKeys, integer, record, string } from "./decode.js";
import { VMError } from "./errors.js";

export const DISK_BRIDGE_VERSION = 2;
export const DISK_BRIDGE_CONTROL_BYTES = 4096;
export const DISK_BRIDGE_COMMAND_CAPACITY = 256;
export const DISK_BRIDGE_COMMAND_DESCRIPTOR_BYTES = 32;
export const DISK_BRIDGE_COMMAND_BYTES =
  DISK_BRIDGE_COMMAND_CAPACITY * DISK_BRIDGE_COMMAND_DESCRIPTOR_BYTES;
export const DISK_BRIDGE_COMPLETION_CAPACITY = 256;
export const DISK_BRIDGE_COMPLETION_DESCRIPTOR_BYTES = 32;
export const DISK_BRIDGE_COMPLETION_BYTES =
  DISK_BRIDGE_COMPLETION_CAPACITY * DISK_BRIDGE_COMPLETION_DESCRIPTOR_BYTES;
export const DISK_BRIDGE_WRITE_ARENA_BYTES = 16 * 1024 * 1024;
export const DISK_BRIDGE_READ_ARENA_BYTES = 16 * 1024 * 1024;
export const DISK_BRIDGE_SYNC_BYTES = 1024 * 1024;

export const DISK_BRIDGE_COMMAND_OFFSET = DISK_BRIDGE_CONTROL_BYTES;
export const DISK_BRIDGE_COMPLETION_OFFSET =
  DISK_BRIDGE_COMMAND_OFFSET + DISK_BRIDGE_COMMAND_BYTES;
export const DISK_BRIDGE_WRITE_ARENA_OFFSET =
  DISK_BRIDGE_COMPLETION_OFFSET + DISK_BRIDGE_COMPLETION_BYTES;
export const DISK_BRIDGE_READ_ARENA_OFFSET =
  DISK_BRIDGE_WRITE_ARENA_OFFSET + DISK_BRIDGE_WRITE_ARENA_BYTES;
export const DISK_BRIDGE_SYNC_OFFSET =
  DISK_BRIDGE_READ_ARENA_OFFSET + DISK_BRIDGE_READ_ARENA_BYTES;
export const DISK_BRIDGE_TOTAL_BYTES =
  DISK_BRIDGE_SYNC_OFFSET + DISK_BRIDGE_SYNC_BYTES;

export const DISK_BRIDGE_READ = 1;
export const DISK_BRIDGE_WRITE = 2;
export const DISK_BRIDGE_ZERO = 3;
export const DISK_BRIDGE_DISCARD = 4;
export const DISK_BRIDGE_FLUSH = 5;

export const DISK_BRIDGE_SUBMIT_ACCEPTED = 0;
export const DISK_BRIDGE_SUBMIT_BACKEND_ERROR = 1;
export const DISK_BRIDGE_SUBMIT_BUSY = 2;
export const DISK_BRIDGE_POLL_PENDING = 0;
export const DISK_BRIDGE_POLL_READY = 1;
export const DISK_BRIDGE_POLL_BACKEND_ERROR = 2;

export const DISK_BRIDGE_FAILURE_NONE = 0;
export const DISK_BRIDGE_FAILURE_BACKEND = 1;
export const DISK_BRIDGE_FAILURE_PROTOCOL = 2;
export const DISK_BRIDGE_FAILURE_TIMEOUT = 3;
/** The origin storage quota is exhausted: the guest sees a block I/O error,
 * the host names the cause so the caller can reclaim or export before data loss. */
export const DISK_BRIDGE_FAILURE_QUOTA = 4;

export const DISK_BRIDGE_CONTROL_VERSION = 0;
export const DISK_BRIDGE_GENERATION = 1;
export const DISK_BRIDGE_COMMAND_HEAD = 2;
export const DISK_BRIDGE_COMMAND_TAIL = 3;
export const DISK_BRIDGE_COMPLETION_HEAD = 4;
export const DISK_BRIDGE_COMPLETION_TAIL = 5;
export const DISK_BRIDGE_WRITE_HEAD = 6;
export const DISK_BRIDGE_WRITE_TAIL = 7;
export const DISK_BRIDGE_READ_HEAD = 8;
export const DISK_BRIDGE_READ_TAIL = 9;
export const DISK_BRIDGE_KICK_PENDING = 10;
export const DISK_BRIDGE_STICKY_SEQUENCE = 11;
export const DISK_BRIDGE_STICKY_REASON = 12;
export const DISK_BRIDGE_SYNC_STATE = 13;
export const DISK_BRIDGE_SYNC_OPERATION = 14;
export const DISK_BRIDGE_SYNC_OFFSET_LOW = 15;
export const DISK_BRIDGE_SYNC_OFFSET_HIGH = 16;
export const DISK_BRIDGE_SYNC_LENGTH = 17;
export const DISK_BRIDGE_SYNC_RESULT = 18;
export const DISK_BRIDGE_SYNC_SEQUENCE = 19;
export const DISK_BRIDGE_SYNC_BARRIER = 20;

export const DISK_BRIDGE_SYNC_IDLE = 0;
export const DISK_BRIDGE_SYNC_REQUESTED = 1;
export const DISK_BRIDGE_SYNC_RESPONDED = 2;

export const DISK_BRIDGE_DESCRIPTOR_SEQUENCE = 0;
export const DISK_BRIDGE_DESCRIPTOR_REQUEST_ID = 1;
export const DISK_BRIDGE_DESCRIPTOR_OPERATION = 2;
export const DISK_BRIDGE_DESCRIPTOR_OFFSET_LOW = 3;
export const DISK_BRIDGE_DESCRIPTOR_OFFSET_HIGH = 4;
export const DISK_BRIDGE_DESCRIPTOR_LENGTH_LOW = 5;
export const DISK_BRIDGE_DESCRIPTOR_LENGTH_HIGH = 6;
export const DISK_BRIDGE_DESCRIPTOR_FLAGS = 7;

export const DISK_BRIDGE_COMPLETION_SEQUENCE = 0;
export const DISK_BRIDGE_COMPLETION_REQUEST_ID = 1;
export const DISK_BRIDGE_COMPLETION_RESULT = 2;
export const DISK_BRIDGE_COMPLETION_LENGTH_LOW = 3;
export const DISK_BRIDGE_COMPLETION_LENGTH_HIGH = 4;
export const DISK_BRIDGE_COMPLETION_FAILURE_REASON = 5;
export const DISK_BRIDGE_COMPLETION_RESERVED_0 = 6;
export const DISK_BRIDGE_COMPLETION_RESERVED_1 = 7;

const DISK_BRIDGE_DESCRIPTOR_WORDS = 8;
const DISK_BRIDGE_TIMEOUT_MILLISECONDS = 30_000;

export interface DiskBridgeViews {
  readonly control: Int32Array<SharedArrayBuffer>;
  readonly commands: Int32Array<SharedArrayBuffer>;
  readonly completions: Int32Array<SharedArrayBuffer>;
  readonly writeArena: Uint8Array<SharedArrayBuffer>;
  readonly readArena: Uint8Array<SharedArrayBuffer>;
  readonly syncWindow: Uint8Array<SharedArrayBuffer>;
}

export type DiskBridgeFailureReason = "backend" | "protocol" | "timeout" | "quota";
export type DiskBridgeOperation = "read" | "write" | "zero" | "flush";

export type DiskBridgeNotice =
  | {
      readonly version: 2;
      readonly type: "disk-kick";
      readonly generation: number;
    }
  | {
      readonly version: 2;
      readonly type: "disk-sync";
      readonly generation: number;
      readonly sequence: number;
    }
  | {
      readonly version: 2;
      readonly type: "disk-reset";
      readonly generation: number;
      readonly nextGeneration: number;
    };

export type DiskBridgeReply =
  | {
      readonly version: 2;
      readonly type: "disk-progress";
      readonly generation: number;
      readonly commandTail: number;
      readonly completionHead: number;
    }
  | {
      readonly version: 2;
      readonly type: "disk-reset-ack";
      readonly generation: number;
      readonly nextGeneration: number;
      readonly ok: boolean;
      readonly reason: number;
    };

export interface DiskBridgeImports {
  readonly disk_read: (
    offsetLow: number,
    offsetHigh: number,
    pointer: number,
    length: number,
  ) => number;
  readonly disk_write: (
    offsetLow: number,
    offsetHigh: number,
    pointer: number,
    length: number,
  ) => number;
  readonly disk_zero: (
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ) => number;
  readonly disk_discard: (
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ) => number;
  readonly disk_flush: () => number;
  readonly disk_read_start: (
    requestId: number,
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ) => number;
  readonly disk_flush_start: (requestId: number) => number;
  readonly disk_poll: (
    requestId: number,
    pointer: number,
    length: number,
  ) => number;
}

export interface DiskBridgeProfile {
  readonly enabled: boolean;
  readonly requests: number;
  readonly failures: number;
  readonly reads: number;
  readonly readBytes: number;
  readonly writes: number;
  readonly writtenBytes: number;
  readonly zeroes: number;
  readonly zeroedBytes: number;
  readonly discards: number;
  readonly discardedBytes: number;
  readonly flushes: number;
  readonly waitMilliseconds: number;
  readonly maximumWaitMilliseconds: number;
  readonly maximumQueueDepth: number;
  readonly busyReturns: number;
  readonly maximumInFlight: number;
  readonly delayedFailures: number;
  readonly backendFailures: number;
  readonly protocolFailures: number;
  readonly timeoutFailures: number;
  readonly quotaFailures: number;
  readonly stickyFailure?: {
    readonly sequence: number;
    readonly reason: DiskBridgeFailureReason;
    readonly operation?: DiskBridgeOperation;
    readonly offset?: number;
    readonly length?: number;
  };
}

type MutableDiskBridgeProfile = {
  -readonly [Key in keyof Omit<
    DiskBridgeProfile,
    "enabled" | "stickyFailure"
  >]: DiskBridgeProfile[Key];
} & {
  stickyFailure?: DiskBridgeProfile["stickyFailure"];
};

interface PendingRequest {
  readonly id: number;
  readonly sequence: number;
  readonly operation: typeof DISK_BRIDGE_READ | typeof DISK_BRIDGE_FLUSH;
  readonly length: number;
  readonly readReservation?: DiskBridgeReservation;
  readonly startedAt: number;
}

interface RecentCommand {
  readonly sequence: number;
  readonly operation: DiskBridgeOperation;
  readonly offset: number;
  readonly length: number;
}

export interface DiskBridgeReservation {
  readonly offset: number;
  readonly padding: number;
  readonly nextHead: number;
}

const EMPTY_PROFILE: Omit<DiskBridgeProfile, "enabled"> = {
  requests: 0,
  failures: 0,
  reads: 0,
  readBytes: 0,
  writes: 0,
  writtenBytes: 0,
  zeroes: 0,
  zeroedBytes: 0,
  discards: 0,
  discardedBytes: 0,
  flushes: 0,
  waitMilliseconds: 0,
  maximumWaitMilliseconds: 0,
  maximumQueueDepth: 0,
  busyReturns: 0,
  maximumInFlight: 0,
  delayedFailures: 0,
  backendFailures: 0,
  protocolFailures: 0,
  timeoutFailures: 0,
  quotaFailures: 0,
};

export const unavailableDiskBridgeImports: DiskBridgeImports = {
  disk_read: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_write: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_zero: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_discard: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_flush: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_read_start: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_flush_start: () => DISK_BRIDGE_SUBMIT_BACKEND_ERROR,
  disk_poll: () => DISK_BRIDGE_POLL_BACKEND_ERROR,
};

export function createDiskBridgeBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(DISK_BRIDGE_TOTAL_BYTES);
  const control = new Int32Array(buffer, 0, DISK_BRIDGE_CONTROL_BYTES / 4);
  Atomics.store(control, DISK_BRIDGE_CONTROL_VERSION, DISK_BRIDGE_VERSION);
  Atomics.store(control, DISK_BRIDGE_GENERATION, 1);
  return buffer;
}

export function diskBridgeViews(buffer: SharedArrayBuffer): DiskBridgeViews {
  if (buffer.byteLength !== DISK_BRIDGE_TOTAL_BYTES) {
    throw new VMError("PROTOCOL_ERROR", "host disk bridge has an invalid size");
  }
  const control = new Int32Array(buffer, 0, DISK_BRIDGE_CONTROL_BYTES / 4);
  if (
    Atomics.load(control, DISK_BRIDGE_CONTROL_VERSION) !== DISK_BRIDGE_VERSION
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "host disk bridge has an invalid version",
    );
  }
  return {
    control,
    commands: new Int32Array(
      buffer,
      DISK_BRIDGE_COMMAND_OFFSET,
      DISK_BRIDGE_COMMAND_BYTES / 4,
    ),
    completions: new Int32Array(
      buffer,
      DISK_BRIDGE_COMPLETION_OFFSET,
      DISK_BRIDGE_COMPLETION_BYTES / 4,
    ),
    writeArena: new Uint8Array(
      buffer,
      DISK_BRIDGE_WRITE_ARENA_OFFSET,
      DISK_BRIDGE_WRITE_ARENA_BYTES,
    ),
    readArena: new Uint8Array(
      buffer,
      DISK_BRIDGE_READ_ARENA_OFFSET,
      DISK_BRIDGE_READ_ARENA_BYTES,
    ),
    syncWindow: new Uint8Array(
      buffer,
      DISK_BRIDGE_SYNC_OFFSET,
      DISK_BRIDGE_SYNC_BYTES,
    ),
  };
}

export function diskBridgeOccupancy(head: number, tail: number): number {
  return (head - tail) >>> 0;
}

export function diskBridgeReservation(
  head: number,
  tail: number,
  length: number,
  capacity: number,
): DiskBridgeReservation | undefined {
  if (
    !Number.isInteger(head) ||
    !Number.isInteger(tail) ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > capacity ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity >= 0x8000_0000
  ) {
    return undefined;
  }
  const unsignedHead = head >>> 0;
  const unsignedTail = tail >>> 0;
  const offset = unsignedHead % capacity;
  const padding = offset + length <= capacity ? 0 : capacity - offset;
  const reserved = padding + length;
  if (diskBridgeOccupancy(unsignedHead, unsignedTail) + reserved > capacity) {
    return undefined;
  }
  return {
    offset: padding === 0 ? offset : 0,
    padding,
    nextHead: (unsignedHead + reserved) >>> 0,
  };
}

export function decodeDiskBridgeNotice(value: unknown): DiskBridgeNotice {
  const notice = record(value, "host disk notice");
  const type = string(notice["type"], "host disk notice type");
  if (type === "disk-kick") {
    exactKeys(notice, ["version", "type", "generation"]);
    return {
      version: decodeVersion(notice["version"]),
      type,
      generation: integer(notice["generation"], "host disk generation", 1),
    };
  }
  if (type === "disk-sync") {
    exactKeys(notice, ["version", "type", "generation", "sequence"]);
    return {
      version: decodeVersion(notice["version"]),
      type,
      generation: integer(notice["generation"], "host disk generation", 1),
      sequence: integer(notice["sequence"], "host disk sequence", 1),
    };
  }
  if (type === "disk-reset") {
    exactKeys(notice, ["version", "type", "generation", "nextGeneration"]);
    return {
      version: decodeVersion(notice["version"]),
      type,
      generation: integer(notice["generation"], "host disk generation", 1),
      nextGeneration: integer(
        notice["nextGeneration"],
        "next host disk generation",
        1,
      ),
    };
  }
  throw new VMError("PROTOCOL_ERROR", "invalid host disk notice");
}

export function decodeDiskBridgeReply(value: unknown): DiskBridgeReply {
  const reply = record(value, "host disk reply");
  const type = string(reply["type"], "host disk reply type");
  if (type === "disk-progress") {
    exactKeys(reply, [
      "version",
      "type",
      "generation",
      "commandTail",
      "completionHead",
    ]);
    return {
      version: decodeVersion(reply["version"]),
      type,
      generation: integer(reply["generation"], "host disk generation", 1),
      commandTail: integer(reply["commandTail"], "host disk command tail", 0),
      completionHead: integer(
        reply["completionHead"],
        "host disk completion head",
        0,
      ),
    };
  }
  if (type === "disk-reset-ack") {
    exactKeys(reply, [
      "version",
      "type",
      "generation",
      "nextGeneration",
      "ok",
      "reason",
    ]);
    return {
      version: decodeVersion(reply["version"]),
      type,
      generation: integer(reply["generation"], "host disk generation", 1),
      nextGeneration: integer(
        reply["nextGeneration"],
        "next host disk generation",
        1,
      ),
      ok: boolean(reply["ok"], "host disk reset result"),
      reason: integer(
        reply["reason"],
        "host disk reset failure reason",
        DISK_BRIDGE_FAILURE_NONE,
        DISK_BRIDGE_FAILURE_TIMEOUT,
      ),
    };
  }
  throw new VMError("PROTOCOL_ERROR", "invalid host disk reply");
}

export class DiskBridgeClient {
  readonly #views: DiskBridgeViews;
  readonly #port: MessagePort;
  readonly #memory: () => WebAssembly.Memory;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #pendingOrder: number[] = [];
  readonly #recentCommands = Array.from(
    { length: DISK_BRIDGE_COMMAND_CAPACITY },
    (): RecentCommand | undefined => undefined,
  );
  readonly #progressWaiters = new Set<() => void>();
  #sequence = 0;
  #syncSequence = 0;
  #readReservationHead = 0;
  #readReservationTail = 0;
  #profile: MutableDiskBridgeProfile | undefined;
  #observedStickySequence = 0;
  #reset:
    | {
        readonly generation: number;
        readonly nextGeneration: number;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  #closed = false;

  constructor(
    buffer: SharedArrayBuffer,
    port: MessagePort,
    memory: () => WebAssembly.Memory,
  ) {
    this.#views = diskBridgeViews(buffer);
    this.#port = port;
    this.#memory = memory;
    port.addEventListener("message", this.#receive);
    port.start();
  }

  readonly imports: DiskBridgeImports = {
    disk_read: (offsetLow, offsetHigh, pointer, length) =>
      this.#syncTransfer(
        DISK_BRIDGE_READ,
        offsetLow,
        offsetHigh,
        pointer,
        length,
      ),
    disk_write: (offsetLow, offsetHigh, pointer, length) =>
      this.#write(offsetLow, offsetHigh, pointer, length),
    disk_zero: (offsetLow, offsetHigh, length) =>
      this.#enqueueMutation(DISK_BRIDGE_ZERO, offsetLow, offsetHigh, length),
    disk_discard: (_offsetLow, _offsetHigh, length) => {
      this.#recordOperation(DISK_BRIDGE_DISCARD, length >>> 0);
      if (this.#stickyReason() !== undefined || this.#closed) {
        this.#recordFailure(this.#stickyReason() ?? DISK_BRIDGE_FAILURE_BACKEND);
        return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
      }
      return DISK_BRIDGE_SUBMIT_ACCEPTED;
    },
    disk_flush: () => this.#syncRequest(DISK_BRIDGE_FLUSH, 0, 0, 0),
    disk_read_start: (requestId, offsetLow, offsetHigh, length) =>
      this.#enqueueDeferred(
        requestId,
        DISK_BRIDGE_READ,
        offsetLow,
        offsetHigh,
        length,
      ),
    disk_flush_start: (requestId) =>
      this.#enqueueDeferred(requestId, DISK_BRIDGE_FLUSH, 0, 0, 0),
    disk_poll: (requestId, pointer, length) =>
      this.#poll(requestId, pointer, length),
  };

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener("message", this.#receive);
    this.#port.close();
    const reset = this.#reset;
    if (reset !== undefined) {
      clearTimeout(reset.timeout);
      reset.reject(new VMError("STORAGE_ERROR", "host disk bridge closed"));
      this.#reset = undefined;
    }
    this.#wakeProgress();
  }

  configureProfiling(enabled: boolean): void {
    this.#profile = enabled ? { ...EMPTY_PROFILE } : undefined;
    this.#observedStickySequence = 0;
  }

  profile(): DiskBridgeProfile {
    this.#observeSticky();
    const profile = this.#profile;
    if (profile === undefined) return { enabled: false, ...EMPTY_PROFILE };
    const { stickyFailure, ...counts } = profile;
    return {
      enabled: true,
      ...counts,
      ...(stickyFailure === undefined ? {} : { stickyFailure }),
    };
  }

  commandDepth(): number {
    return diskBridgeOccupancy(
      Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_HEAD),
      Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_TAIL),
    );
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  async waitForProgress(): Promise<void> {
    if (
      (this.commandDepth() === 0 && this.#pending.size === 0) ||
      this.#closed
    ) {
      return;
    }
    await new Promise<void>((resolve) => this.#progressWaiters.add(resolve));
  }

  reset(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new VMError("STORAGE_ERROR", "host disk bridge closed"),
      );
    }
    if (this.#reset !== undefined) return Promise.reject(
      new VMError("PROTOCOL_ERROR", "host disk reset is already pending"),
    );
    if (this.commandDepth() !== 0 || this.#pending.size !== 0) {
      return Promise.reject(
        new VMError("PROTOCOL_ERROR", "host disk reset is not quiescent"),
      );
    }
    const generation = this.#generation();
    const nextGeneration = nextCounter(generation);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#reset = undefined;
        this.#recordFailure(DISK_BRIDGE_FAILURE_TIMEOUT);
        reject(new VMError("STORAGE_ERROR", "host disk reset timed out"));
      }, DISK_BRIDGE_TIMEOUT_MILLISECONDS);
      this.#reset = { generation, nextGeneration, resolve, reject, timeout };
      this.#port.postMessage({
        version: DISK_BRIDGE_VERSION,
        type: "disk-reset",
        generation,
        nextGeneration,
      } satisfies DiskBridgeNotice);
    });
  }

  #write(
    offsetLow: number,
    offsetHigh: number,
    pointer: number,
    length: number,
  ): number {
    const unsignedLength = length >>> 0;
    const memory = this.#memoryBytes(pointer, unsignedLength);
    if (memory === undefined) {
      this.#recordOperation(DISK_BRIDGE_WRITE, unsignedLength);
      this.#recordFailure(DISK_BRIDGE_FAILURE_PROTOCOL);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    return this.#enqueue(
      DISK_BRIDGE_WRITE,
      0,
      offsetLow,
      offsetHigh,
      unsignedLength,
      memory,
    );
  }

  #enqueueMutation(
    operation: typeof DISK_BRIDGE_ZERO,
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ): number {
    return this.#enqueue(
      operation,
      0,
      offsetLow,
      offsetHigh,
      length >>> 0,
    );
  }

  #enqueueDeferred(
    requestId: number,
    operation: typeof DISK_BRIDGE_READ | typeof DISK_BRIDGE_FLUSH,
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ): number {
    const id = requestId >>> 0;
    const unsignedLength = length >>> 0;
    if (id === 0 || this.#pending.has(id)) {
      this.#recordOperation(operation, unsignedLength);
      this.#recordFailure(DISK_BRIDGE_FAILURE_PROTOCOL);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    let readReservation: DiskBridgeReservation | undefined;
    if (operation === DISK_BRIDGE_READ) {
      readReservation = diskBridgeReservation(
        this.#readReservationHead,
        this.#readReservationTail,
        unsignedLength,
        DISK_BRIDGE_READ_ARENA_BYTES,
      );
      if (readReservation === undefined) {
        this.#recordOperation(operation, unsignedLength);
        this.#recordBusy();
        return DISK_BRIDGE_SUBMIT_BUSY;
      }
    } else if (unsignedLength !== 0) {
      this.#recordOperation(operation, unsignedLength);
      this.#recordFailure(DISK_BRIDGE_FAILURE_PROTOCOL);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    const result = this.#enqueue(
      operation,
      id,
      offsetLow,
      offsetHigh,
      unsignedLength,
    );
    if (result !== DISK_BRIDGE_SUBMIT_ACCEPTED) return result;
    if (readReservation !== undefined) {
      this.#readReservationHead = readReservation.nextHead;
    }
    const sequence = this.#sequence;
    this.#pending.set(id, {
      id,
      sequence,
      operation,
      length: unsignedLength,
      ...(readReservation === undefined ? {} : { readReservation }),
      startedAt: performance.now(),
    });
    this.#pendingOrder.push(id);
    const profile = this.#profile;
    if (profile !== undefined) {
      profile.maximumInFlight = Math.max(
        profile.maximumInFlight,
        this.#pending.size,
      );
    }
    return result;
  }

  #enqueue(
    operation: number,
    requestId: number,
    offsetLow: number,
    offsetHigh: number,
    length: number,
    payload?: Uint8Array,
  ): number {
    this.#recordOperation(operation, length);
    const sticky = this.#stickyReason();
    if (sticky !== undefined || this.#closed || length > 0xffff_ffff) {
      this.#recordFailure(sticky ?? DISK_BRIDGE_FAILURE_BACKEND);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    const control = this.#views.control;
    const head = Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD) >>> 0;
    const tail = Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0;
    if (diskBridgeOccupancy(head, tail) >= DISK_BRIDGE_COMMAND_CAPACITY) {
      this.#recordBusy();
      return DISK_BRIDGE_SUBMIT_BUSY;
    }
    let writeReservation: DiskBridgeReservation | undefined;
    if (payload !== undefined) {
      writeReservation = diskBridgeReservation(
        Atomics.load(control, DISK_BRIDGE_WRITE_HEAD),
        Atomics.load(control, DISK_BRIDGE_WRITE_TAIL),
        payload.byteLength,
        DISK_BRIDGE_WRITE_ARENA_BYTES,
      );
      if (writeReservation === undefined) {
        this.#recordBusy();
        return DISK_BRIDGE_SUBMIT_BUSY;
      }
      this.#views.writeArena.set(payload, writeReservation.offset);
      Atomics.store(control, DISK_BRIDGE_WRITE_HEAD, writeReservation.nextHead);
    }
    const sequence = this.#nextSequence();
    const commandRequestId = requestId === 0 ? sequence : requestId;
    const commandOffset = (offsetHigh >>> 0) * 0x1_0000_0000 + (offsetLow >>> 0);
    const commandOperation = diskBridgeOperationName(operation);
    if (commandOperation !== undefined && Number.isSafeInteger(commandOffset)) {
      this.#recentCommands[(sequence - 1) % DISK_BRIDGE_COMMAND_CAPACITY] = {
        sequence,
        operation: commandOperation,
        offset: commandOffset,
        length,
      };
    }
    const descriptor = (head % DISK_BRIDGE_COMMAND_CAPACITY) * DISK_BRIDGE_DESCRIPTOR_WORDS;
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_SEQUENCE, sequence);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_REQUEST_ID, commandRequestId);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_OPERATION, operation);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_OFFSET_LOW, offsetLow);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_OFFSET_HIGH, offsetHigh);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_LENGTH_LOW, length);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_LENGTH_HIGH, 0);
    Atomics.store(this.#views.commands, descriptor + DISK_BRIDGE_DESCRIPTOR_FLAGS, 0);
    const nextHead = (head + 1) >>> 0;
    Atomics.store(control, DISK_BRIDGE_COMMAND_HEAD, nextHead);
    const profile = this.#profile;
    if (profile !== undefined) {
      profile.maximumQueueDepth = Math.max(
        profile.maximumQueueDepth,
        diskBridgeOccupancy(nextHead, tail),
      );
    }
    this.#kick();
    return DISK_BRIDGE_SUBMIT_ACCEPTED;
  }

  #poll(requestId: number, pointer: number, length: number): number {
    const id = requestId >>> 0;
    const pending = this.#pending.get(id);
    if (pending === undefined) return DISK_BRIDGE_POLL_BACKEND_ERROR;
    if (this.#pendingOrder[0] !== id) return DISK_BRIDGE_POLL_PENDING;
    const sticky = this.#stickyReason();
    if (sticky !== undefined) {
      const stickySequence =
        Atomics.load(
          this.#views.control,
          DISK_BRIDGE_STICKY_SEQUENCE,
        ) >>> 0;
      this.#discardCompletion(id);
      this.#finishPending(pending);
      if (stickySequence !== pending.sequence) this.#recordFailure(sticky);
      return DISK_BRIDGE_POLL_BACKEND_ERROR;
    }
    const control = this.#views.control;
    const tail = Atomics.load(control, DISK_BRIDGE_COMPLETION_TAIL) >>> 0;
    const head = Atomics.load(control, DISK_BRIDGE_COMPLETION_HEAD) >>> 0;
    if (tail === head) return DISK_BRIDGE_POLL_PENDING;
    if (diskBridgeOccupancy(head, tail) > DISK_BRIDGE_COMPLETION_CAPACITY) {
      return this.#failPendingProtocol(pending);
    }
    const descriptor =
      (tail % DISK_BRIDGE_COMPLETION_CAPACITY) * DISK_BRIDGE_DESCRIPTOR_WORDS;
    const completionId =
      Atomics.load(
        this.#views.completions,
        descriptor + DISK_BRIDGE_COMPLETION_REQUEST_ID,
      ) >>> 0;
    const completionSequence =
      Atomics.load(
        this.#views.completions,
        descriptor + DISK_BRIDGE_COMPLETION_SEQUENCE,
      ) >>> 0;
    const completionLength =
      Atomics.load(
        this.#views.completions,
        descriptor + DISK_BRIDGE_COMPLETION_LENGTH_LOW,
      ) >>> 0;
    const lengthHigh = Atomics.load(
      this.#views.completions,
      descriptor + DISK_BRIDGE_COMPLETION_LENGTH_HIGH,
    );
    const reserved0 = Atomics.load(
      this.#views.completions,
      descriptor + DISK_BRIDGE_COMPLETION_RESERVED_0,
    );
    const reserved1 = Atomics.load(
      this.#views.completions,
      descriptor + DISK_BRIDGE_COMPLETION_RESERVED_1,
    );
    if (
      completionSequence !== pending.sequence ||
      completionId !== id ||
      completionLength !== pending.length ||
      lengthHigh !== 0 ||
      reserved0 !== 0 ||
      reserved1 !== 0
    ) {
      return this.#failPendingProtocol(pending);
    }
    const result = Atomics.load(
      this.#views.completions,
      descriptor + DISK_BRIDGE_COMPLETION_RESULT,
    );
    const reason = Atomics.load(
      this.#views.completions,
      descriptor + DISK_BRIDGE_COMPLETION_FAILURE_REASON,
    );
    let pollResult = DISK_BRIDGE_POLL_READY;
    if (result === 0 && reason === DISK_BRIDGE_FAILURE_NONE) {
      if (pending.operation === DISK_BRIDGE_READ) {
        const memory = this.#memoryBytes(pointer, length >>> 0);
        const reservation = pending.readReservation;
        if (
          memory === undefined ||
          length >>> 0 !== pending.length ||
          reservation === undefined
        ) {
          pollResult = DISK_BRIDGE_POLL_BACKEND_ERROR;
          this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, pending.sequence);
        } else {
          memory.set(
            this.#views.readArena.subarray(
              reservation.offset,
              reservation.offset + pending.length,
            ),
          );
        }
      } else if ((pointer >>> 0) !== 0 || (length >>> 0) !== 0) {
        pollResult = DISK_BRIDGE_POLL_BACKEND_ERROR;
        this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, pending.sequence);
      }
    } else if (result === 1 && isFailureReason(reason)) {
      pollResult = DISK_BRIDGE_POLL_BACKEND_ERROR;
      this.#recordFailure(reason);
    } else {
      pollResult = DISK_BRIDGE_POLL_BACKEND_ERROR;
      this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, pending.sequence);
    }
    Atomics.store(control, DISK_BRIDGE_COMPLETION_TAIL, (tail + 1) >>> 0);
    this.#finishPending(pending);
    if (this.commandDepth() !== 0) this.#kick();
    return pollResult;
  }

  #finishPending(pending: PendingRequest): void {
    this.#pending.delete(pending.id);
    this.#pendingOrder.shift();
    if (pending.readReservation !== undefined) {
      this.#readReservationTail = pending.readReservation.nextHead;
      Atomics.store(
        this.#views.control,
        DISK_BRIDGE_READ_TAIL,
        pending.readReservation.nextHead,
      );
    }
    const profile = this.#profile;
    if (profile !== undefined) {
      const elapsed = performance.now() - pending.startedAt;
      profile.waitMilliseconds += elapsed;
      profile.maximumWaitMilliseconds = Math.max(
        profile.maximumWaitMilliseconds,
        elapsed,
      );
    }
  }

  #discardCompletion(requestId: number): void {
    const control = this.#views.control;
    const tail = Atomics.load(control, DISK_BRIDGE_COMPLETION_TAIL) >>> 0;
    if (
      tail === (Atomics.load(control, DISK_BRIDGE_COMPLETION_HEAD) >>> 0)
    ) {
      return;
    }
    const descriptor =
      (tail % DISK_BRIDGE_COMPLETION_CAPACITY) * DISK_BRIDGE_DESCRIPTOR_WORDS;
    if (
      (Atomics.load(
        this.#views.completions,
        descriptor + DISK_BRIDGE_COMPLETION_REQUEST_ID,
      ) >>>
        0) === requestId
    ) {
      Atomics.store(control, DISK_BRIDGE_COMPLETION_TAIL, (tail + 1) >>> 0);
    }
  }

  #failPendingProtocol(pending: PendingRequest): number {
    this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, pending.sequence);
    this.#finishPending(pending);
    return DISK_BRIDGE_POLL_BACKEND_ERROR;
  }

  #syncTransfer(
    operation: typeof DISK_BRIDGE_READ,
    offsetLow: number,
    offsetHigh: number,
    pointer: number,
    length: number,
  ): number {
    const unsignedLength = length >>> 0;
    const memory = this.#memoryBytes(pointer, unsignedLength);
    if (memory === undefined || unsignedLength > this.#views.syncWindow.byteLength) {
      this.#recordOperation(operation, unsignedLength);
      this.#recordFailure(DISK_BRIDGE_FAILURE_PROTOCOL);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    const result = this.#syncRequest(
      operation,
      offsetLow,
      offsetHigh,
      unsignedLength,
    );
    if (result === DISK_BRIDGE_SUBMIT_ACCEPTED) {
      memory.set(this.#views.syncWindow.subarray(0, unsignedLength));
    }
    return result;
  }

  #syncRequest(
    operation: typeof DISK_BRIDGE_READ | typeof DISK_BRIDGE_FLUSH,
    offsetLow: number,
    offsetHigh: number,
    length: number,
  ): number {
    this.#recordOperation(operation, length);
    const sticky = this.#stickyReason();
    const control = this.#views.control;
    if (
      sticky !== undefined ||
      this.#closed ||
      Atomics.compareExchange(
        control,
        DISK_BRIDGE_SYNC_STATE,
        DISK_BRIDGE_SYNC_IDLE,
        DISK_BRIDGE_SYNC_REQUESTED,
      ) !== DISK_BRIDGE_SYNC_IDLE
    ) {
      this.#recordFailure(sticky ?? DISK_BRIDGE_FAILURE_BACKEND);
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    const sequence = nextCounter(this.#syncSequence);
    this.#syncSequence = sequence;
    Atomics.store(control, DISK_BRIDGE_SYNC_OPERATION, operation);
    Atomics.store(control, DISK_BRIDGE_SYNC_OFFSET_LOW, offsetLow);
    Atomics.store(control, DISK_BRIDGE_SYNC_OFFSET_HIGH, offsetHigh);
    Atomics.store(control, DISK_BRIDGE_SYNC_LENGTH, length);
    Atomics.store(control, DISK_BRIDGE_SYNC_RESULT, DISK_BRIDGE_FAILURE_BACKEND);
    Atomics.store(control, DISK_BRIDGE_SYNC_SEQUENCE, sequence);
    Atomics.store(
      control,
      DISK_BRIDGE_SYNC_BARRIER,
      Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD),
    );
    this.#port.postMessage({
      version: DISK_BRIDGE_VERSION,
      type: "disk-sync",
      generation: this.#generation(),
      sequence,
    } satisfies DiskBridgeNotice);
    const startedAt = performance.now();
    const wait = Atomics.wait(
      control,
      DISK_BRIDGE_SYNC_STATE,
      DISK_BRIDGE_SYNC_REQUESTED,
      DISK_BRIDGE_TIMEOUT_MILLISECONDS,
    );
    const responded =
      wait !== "timed-out" &&
      Atomics.load(control, DISK_BRIDGE_SYNC_STATE) ===
        DISK_BRIDGE_SYNC_RESPONDED &&
      (Atomics.load(control, DISK_BRIDGE_SYNC_SEQUENCE) >>> 0) === sequence;
    const result = responded
      ? Atomics.load(control, DISK_BRIDGE_SYNC_RESULT)
      : DISK_BRIDGE_FAILURE_TIMEOUT;
    Atomics.store(control, DISK_BRIDGE_SYNC_STATE, DISK_BRIDGE_SYNC_IDLE);
    const profile = this.#profile;
    if (profile !== undefined) {
      const elapsed = performance.now() - startedAt;
      profile.waitMilliseconds += elapsed;
      profile.maximumWaitMilliseconds = Math.max(
        profile.maximumWaitMilliseconds,
        elapsed,
      );
    }
    if (result !== DISK_BRIDGE_FAILURE_NONE) {
      this.#recordFailure(
        isFailureReason(result) ? result : DISK_BRIDGE_FAILURE_PROTOCOL,
      );
      return DISK_BRIDGE_SUBMIT_BACKEND_ERROR;
    }
    return DISK_BRIDGE_SUBMIT_ACCEPTED;
  }

  #kick(): void {
    if (
      Atomics.compareExchange(
        this.#views.control,
        DISK_BRIDGE_KICK_PENDING,
        0,
        1,
      ) !== 0
    ) {
      return;
    }
    this.#port.postMessage({
      version: DISK_BRIDGE_VERSION,
      type: "disk-kick",
      generation: this.#generation(),
    } satisfies DiskBridgeNotice);
  }

  readonly #receive = (event: MessageEvent<unknown>): void => {
    let reply: DiskBridgeReply;
    try {
      reply = decodeDiskBridgeReply(event.data);
    } catch {
      this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, this.#nextSequence());
      this.#wakeProgress();
      return;
    }
    if (reply.type === "disk-progress") {
      if (reply.generation !== this.#generation()) {
        this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, this.#nextSequence());
      }
      this.#observeSticky();
      this.#wakeProgress();
      if (this.#storageCanProgress()) this.#kick();
      return;
    }
    const reset = this.#reset;
    if (
      reset === undefined ||
      reply.generation !== reset.generation ||
      reply.nextGeneration !== reset.nextGeneration
    ) {
      this.#setSticky(DISK_BRIDGE_FAILURE_PROTOCOL, this.#nextSequence());
      return;
    }
    clearTimeout(reset.timeout);
    this.#reset = undefined;
    if (!reply.ok || reply.reason !== DISK_BRIDGE_FAILURE_NONE) {
      const reason = isFailureReason(reply.reason)
        ? reply.reason
        : DISK_BRIDGE_FAILURE_PROTOCOL;
      this.#recordFailure(reason);
      reset.reject(new VMError("STORAGE_ERROR", "host disk reset failed"));
      return;
    }
    this.#sequence = 0;
    this.#syncSequence = 0;
    this.#readReservationHead = 0;
    this.#readReservationTail = 0;
    this.#observedStickySequence = 0;
    this.#recentCommands.fill(undefined);
    reset.resolve();
  };

  #wakeProgress(): void {
    for (const resolve of this.#progressWaiters) resolve();
    this.#progressWaiters.clear();
  }

  #storageCanProgress(): boolean {
    const control = this.#views.control;
    const head = Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD) >>> 0;
    const tail = Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0;
    const depth = diskBridgeOccupancy(head, tail);
    if (depth === 0 || depth > DISK_BRIDGE_COMMAND_CAPACITY) return false;
    const completionDepth = diskBridgeOccupancy(
      Atomics.load(control, DISK_BRIDGE_COMPLETION_HEAD),
      Atomics.load(control, DISK_BRIDGE_COMPLETION_TAIL),
    );
    if (completionDepth >= DISK_BRIDGE_COMPLETION_CAPACITY) return false;
    const descriptor =
      (tail % DISK_BRIDGE_COMMAND_CAPACITY) * DISK_BRIDGE_DESCRIPTOR_WORDS;
    if (
      Atomics.load(
        this.#views.commands,
        descriptor + DISK_BRIDGE_DESCRIPTOR_OPERATION,
      ) !== DISK_BRIDGE_READ
    ) {
      return true;
    }
    return (
      diskBridgeReservation(
        Atomics.load(control, DISK_BRIDGE_READ_HEAD),
        Atomics.load(control, DISK_BRIDGE_READ_TAIL),
        Atomics.load(
          this.#views.commands,
          descriptor + DISK_BRIDGE_DESCRIPTOR_LENGTH_LOW,
        ) >>> 0,
        DISK_BRIDGE_READ_ARENA_BYTES,
      ) !== undefined
    );
  }

  #memoryBytes(pointer: number, length: number): Uint8Array | undefined {
    if (length === 0) return undefined;
    try {
      return new Uint8Array(this.#memory().buffer, pointer >>> 0, length);
    } catch {
      return undefined;
    }
  }

  #generation(): number {
    return Atomics.load(this.#views.control, DISK_BRIDGE_GENERATION) >>> 0;
  }

  #nextSequence(): number {
    this.#sequence = nextCounter(this.#sequence);
    return this.#sequence;
  }

  #stickyReason(): number | undefined {
    this.#observeSticky();
    const sequence =
      Atomics.load(this.#views.control, DISK_BRIDGE_STICKY_SEQUENCE) >>> 0;
    if (sequence === 0) return undefined;
    const reason = Atomics.load(
      this.#views.control,
      DISK_BRIDGE_STICKY_REASON,
    );
    return isFailureReason(reason) ? reason : DISK_BRIDGE_FAILURE_PROTOCOL;
  }

  #observeSticky(): void {
    const profile = this.#profile;
    if (profile === undefined) return;
    const sequence =
      Atomics.load(this.#views.control, DISK_BRIDGE_STICKY_SEQUENCE) >>> 0;
    if (sequence === 0 || sequence === this.#observedStickySequence) return;
    const rawReason = Atomics.load(
      this.#views.control,
      DISK_BRIDGE_STICKY_REASON,
    );
    const reason = isFailureReason(rawReason)
      ? rawReason
      : DISK_BRIDGE_FAILURE_PROTOCOL;
    this.#observedStickySequence = sequence;
    profile.delayedFailures += 1;
    this.#recordFailure(reason);
    const command = this.#recentCommands[
      (sequence - 1) % DISK_BRIDGE_COMMAND_CAPACITY
    ];
    profile.stickyFailure = {
      sequence,
      reason: failureReasonName(reason),
      ...(command?.sequence === sequence
        ? {
            operation: command.operation,
            offset: command.offset,
            length: command.length,
          }
        : {}),
    };
  }

  #setSticky(reason: number, sequence: number): void {
    const control = this.#views.control;
    if (Atomics.load(control, DISK_BRIDGE_STICKY_SEQUENCE) !== 0) return;
    Atomics.store(control, DISK_BRIDGE_STICKY_REASON, reason);
    Atomics.compareExchange(
      control,
      DISK_BRIDGE_STICKY_SEQUENCE,
      0,
      sequence || 1,
    );
    this.#observeSticky();
  }

  #recordOperation(operation: number, length: number): void {
    const profile = this.#profile;
    if (profile === undefined) return;
    profile.requests += 1;
    switch (operation) {
      case DISK_BRIDGE_READ:
        profile.reads += 1;
        profile.readBytes += length;
        break;
      case DISK_BRIDGE_WRITE:
        profile.writes += 1;
        profile.writtenBytes += length;
        break;
      case DISK_BRIDGE_ZERO:
        profile.zeroes += 1;
        profile.zeroedBytes += length;
        break;
      case DISK_BRIDGE_DISCARD:
        profile.discards += 1;
        profile.discardedBytes += length;
        break;
      case DISK_BRIDGE_FLUSH:
        profile.flushes += 1;
        break;
    }
  }

  #recordBusy(): void {
    const profile = this.#profile;
    if (profile !== undefined) profile.busyReturns += 1;
  }

  #recordFailure(reason: number): void {
    const profile = this.#profile;
    if (profile === undefined) return;
    profile.failures += 1;
    switch (reason) {
      case DISK_BRIDGE_FAILURE_BACKEND:
        profile.backendFailures += 1;
        break;
      case DISK_BRIDGE_FAILURE_TIMEOUT:
        profile.timeoutFailures += 1;
        break;
      case DISK_BRIDGE_FAILURE_QUOTA:
        profile.quotaFailures += 1;
        break;
      default:
        profile.protocolFailures += 1;
        break;
    }
  }
}

function decodeVersion(value: unknown): 2 {
  if (
    integer(
      value,
      "host disk bridge version",
      DISK_BRIDGE_VERSION,
      DISK_BRIDGE_VERSION,
    ) !== DISK_BRIDGE_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "invalid host disk bridge version");
  }
  return DISK_BRIDGE_VERSION;
}

function nextCounter(value: number): number {
  const next = ((value >>> 0) + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function isFailureReason(value: number): boolean {
  return (
    value === DISK_BRIDGE_FAILURE_BACKEND ||
    value === DISK_BRIDGE_FAILURE_PROTOCOL ||
    value === DISK_BRIDGE_FAILURE_TIMEOUT ||
    value === DISK_BRIDGE_FAILURE_QUOTA
  );
}

function failureReasonName(reason: number): DiskBridgeFailureReason {
  switch (reason) {
    case DISK_BRIDGE_FAILURE_BACKEND:
      return "backend";
    case DISK_BRIDGE_FAILURE_TIMEOUT:
      return "timeout";
    case DISK_BRIDGE_FAILURE_QUOTA:
      return "quota";
    default:
      return "protocol";
  }
}

function diskBridgeOperationName(
  operation: number,
): DiskBridgeOperation | undefined {
  switch (operation) {
    case DISK_BRIDGE_READ:
      return "read";
    case DISK_BRIDGE_WRITE:
      return "write";
    case DISK_BRIDGE_ZERO:
      return "zero";
    case DISK_BRIDGE_FLUSH:
      return "flush";
    default:
      return undefined;
  }
}
