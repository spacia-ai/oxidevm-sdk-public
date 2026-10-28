import {
  decodeDiskBridgeNotice,
  DISK_BRIDGE_COMMAND_CAPACITY,
  DISK_BRIDGE_COMMAND_HEAD,
  DISK_BRIDGE_COMMAND_TAIL,
  DISK_BRIDGE_COMPLETION_CAPACITY,
  DISK_BRIDGE_COMPLETION_FAILURE_REASON,
  DISK_BRIDGE_COMPLETION_HEAD,
  DISK_BRIDGE_COMPLETION_LENGTH_HIGH,
  DISK_BRIDGE_COMPLETION_LENGTH_LOW,
  DISK_BRIDGE_COMPLETION_REQUEST_ID,
  DISK_BRIDGE_COMPLETION_RESERVED_0,
  DISK_BRIDGE_COMPLETION_RESERVED_1,
  DISK_BRIDGE_COMPLETION_RESULT,
  DISK_BRIDGE_COMPLETION_SEQUENCE,
  DISK_BRIDGE_COMPLETION_TAIL,
  DISK_BRIDGE_DESCRIPTOR_FLAGS,
  DISK_BRIDGE_DESCRIPTOR_LENGTH_HIGH,
  DISK_BRIDGE_DESCRIPTOR_LENGTH_LOW,
  DISK_BRIDGE_DESCRIPTOR_OFFSET_HIGH,
  DISK_BRIDGE_DESCRIPTOR_OFFSET_LOW,
  DISK_BRIDGE_DESCRIPTOR_OPERATION,
  DISK_BRIDGE_DESCRIPTOR_REQUEST_ID,
  DISK_BRIDGE_DESCRIPTOR_SEQUENCE,
  DISK_BRIDGE_FAILURE_BACKEND,
  DISK_BRIDGE_FAILURE_NONE,
  DISK_BRIDGE_FAILURE_PROTOCOL,
  DISK_BRIDGE_FAILURE_QUOTA,
  DISK_BRIDGE_FLUSH,
  DISK_BRIDGE_GENERATION,
  DISK_BRIDGE_KICK_PENDING,
  DISK_BRIDGE_READ,
  DISK_BRIDGE_READ_ARENA_BYTES,
  DISK_BRIDGE_READ_HEAD,
  DISK_BRIDGE_READ_TAIL,
  DISK_BRIDGE_STICKY_REASON,
  DISK_BRIDGE_STICKY_SEQUENCE,
  DISK_BRIDGE_SYNC_BARRIER,
  DISK_BRIDGE_SYNC_IDLE,
  DISK_BRIDGE_SYNC_LENGTH,
  DISK_BRIDGE_SYNC_OFFSET_HIGH,
  DISK_BRIDGE_SYNC_OFFSET_LOW,
  DISK_BRIDGE_SYNC_OPERATION,
  DISK_BRIDGE_SYNC_REQUESTED,
  DISK_BRIDGE_SYNC_RESPONDED,
  DISK_BRIDGE_SYNC_RESULT,
  DISK_BRIDGE_SYNC_SEQUENCE,
  DISK_BRIDGE_SYNC_STATE,
  DISK_BRIDGE_VERSION,
  DISK_BRIDGE_WRITE,
  DISK_BRIDGE_WRITE_ARENA_BYTES,
  DISK_BRIDGE_WRITE_HEAD,
  DISK_BRIDGE_WRITE_TAIL,
  DISK_BRIDGE_ZERO,
  diskBridgeOccupancy,
  diskBridgeReservation,
  diskBridgeViews,
  type DiskBridgeNotice,
  type DiskBridgeReply,
  type DiskBridgeViews,
} from "../disk-bridge.js";
import { VMError } from "../errors.js";

const DESCRIPTOR_WORDS = 8;

export interface StorageBridgeDisk {
  read(offset: number, target: Uint8Array): void;
  write(offset: number, source: Uint8Array): void;
  zero(offset: number, length: number): void;
  flush(): void;
}

interface Command {
  readonly sequence: number;
  readonly requestId: number;
  readonly operation: number;
  readonly offset: number;
  readonly length: number;
}

export class StorageDiskBridge {
  readonly #views: DiskBridgeViews;
  readonly #port: MessagePort;
  readonly #disk: () => StorageBridgeDisk | undefined;
  #lastCommandSequence = 0;
  #closed = false;

  constructor(
    buffer: SharedArrayBuffer,
    port: MessagePort,
    disk: () => StorageBridgeDisk | undefined,
  ) {
    this.#views = diskBridgeViews(buffer);
    this.#port = port;
    this.#disk = disk;
    port.addEventListener("message", this.#receive);
    port.start();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener("message", this.#receive);
    this.#port.close();
  }

  service(value: unknown): void {
    try {
      const notice = decodeDiskBridgeNotice(value);
      if (notice.generation !== this.#generation()) {
        throw new VMError("PROTOCOL_ERROR", "host disk generation is stale");
      }
      switch (notice.type) {
        case "disk-kick":
          this.#serviceKick();
          break;
        case "disk-sync":
          this.#serviceSync(notice);
          break;
        case "disk-reset":
          this.#serviceReset(notice);
          break;
      }
    } catch (error) {
      this.#fail(this.#nextCommandSequence(), failureReason(error));
      this.#postProgress();
    }
  }

  readonly #receive = (event: MessageEvent<unknown>): void => {
    this.service(event.data);
  };

  #serviceKick(): void {
    do {
      const drained = this.#drain();
      Atomics.store(this.#views.control, DISK_BRIDGE_KICK_PENDING, 0);
      if (!drained || this.#commandDepth() === 0) break;
    } while (
      Atomics.compareExchange(
        this.#views.control,
        DISK_BRIDGE_KICK_PENDING,
        0,
        1,
      ) === 0
    );
    this.#postProgress();
  }

  #drain(): boolean {
    return this.#drainUntil(
      Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_HEAD) >>> 0,
    );
  }

  #drainUntil(target: number): boolean {
    const control = this.#views.control;
    const tail = Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0;
    const head = Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD) >>> 0;
    if (
      diskBridgeOccupancy(target, tail) > DISK_BRIDGE_COMMAND_CAPACITY ||
      diskBridgeOccupancy(head, target) > DISK_BRIDGE_COMMAND_CAPACITY
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk barrier is invalid");
    }
    while (
      (Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0) !== target
    ) {
      const tail = Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0;
      const command = this.#readCommand(tail);
      if (this.#backpressured(command)) return false;
      try {
        this.#execute(command);
        this.#lastCommandSequence = command.sequence;
        Atomics.store(control, DISK_BRIDGE_COMMAND_TAIL, (tail + 1) >>> 0);
      } catch (error) {
        this.#fail(command.sequence, failureReason(error));
        return true;
      }
    }
    return true;
  }

  #backpressured(command: Command): boolean {
    if (
      command.operation !== DISK_BRIDGE_READ &&
      command.operation !== DISK_BRIDGE_FLUSH
    ) {
      return false;
    }
    const control = this.#views.control;
    const completionDepth = diskBridgeOccupancy(
      Atomics.load(control, DISK_BRIDGE_COMPLETION_HEAD),
      Atomics.load(control, DISK_BRIDGE_COMPLETION_TAIL),
    );
    if (completionDepth > DISK_BRIDGE_COMPLETION_CAPACITY) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "host disk completion ring overflowed",
      );
    }
    if (completionDepth === DISK_BRIDGE_COMPLETION_CAPACITY) return true;
    if (command.operation === DISK_BRIDGE_FLUSH) return false;
    const head = Atomics.load(control, DISK_BRIDGE_READ_HEAD) >>> 0;
    const tail = Atomics.load(control, DISK_BRIDGE_READ_TAIL) >>> 0;
    const depth = diskBridgeOccupancy(head, tail);
    if (depth > DISK_BRIDGE_READ_ARENA_BYTES) {
      throw new VMError("PROTOCOL_ERROR", "host disk read arena overflowed");
    }
    return (
      diskBridgeReservation(
        head,
        tail,
        command.length,
        DISK_BRIDGE_READ_ARENA_BYTES,
      ) === undefined
    );
  }

  #readCommand(tail: number): Command {
    const base = (tail % DISK_BRIDGE_COMMAND_CAPACITY) * DESCRIPTOR_WORDS;
    const commands = this.#views.commands;
    const sequence =
      Atomics.load(commands, base + DISK_BRIDGE_DESCRIPTOR_SEQUENCE) >>> 0;
    const requestId =
      Atomics.load(commands, base + DISK_BRIDGE_DESCRIPTOR_REQUEST_ID) >>> 0;
    const operation = Atomics.load(
      commands,
      base + DISK_BRIDGE_DESCRIPTOR_OPERATION,
    );
    const offsetLow =
      Atomics.load(commands, base + DISK_BRIDGE_DESCRIPTOR_OFFSET_LOW) >>> 0;
    const offsetHigh =
      Atomics.load(commands, base + DISK_BRIDGE_DESCRIPTOR_OFFSET_HIGH) >>> 0;
    const length =
      Atomics.load(commands, base + DISK_BRIDGE_DESCRIPTOR_LENGTH_LOW) >>> 0;
    const lengthHigh = Atomics.load(
      commands,
      base + DISK_BRIDGE_DESCRIPTOR_LENGTH_HIGH,
    );
    const flags = Atomics.load(
      commands,
      base + DISK_BRIDGE_DESCRIPTOR_FLAGS,
    );
    const offset = offsetHigh * 0x1_0000_0000 + offsetLow;
    if (
      sequence !== nextSequence(this.#lastCommandSequence) ||
      requestId === 0 ||
      lengthHigh !== 0 ||
      flags !== 0 ||
      !Number.isSafeInteger(offset) ||
      !validCommand(operation, offset, length)
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk command is invalid");
    }
    return { sequence, requestId, operation, offset, length };
  }

  #execute(command: Command): void {
    const disk = this.#disk();
    if (disk === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk is not prepared");
    }
    switch (command.operation) {
      case DISK_BRIDGE_WRITE:
        this.#write(disk, command);
        break;
      case DISK_BRIDGE_ZERO:
        disk.zero(command.offset, command.length);
        break;
      case DISK_BRIDGE_READ:
        this.#read(disk, command);
        break;
      case DISK_BRIDGE_FLUSH:
        disk.flush();
        this.#complete(command, DISK_BRIDGE_FAILURE_NONE);
        break;
      default:
        throw new VMError("PROTOCOL_ERROR", "host disk operation is invalid");
    }
  }

  #write(disk: StorageBridgeDisk, command: Command): void {
    const control = this.#views.control;
    const tail = Atomics.load(control, DISK_BRIDGE_WRITE_TAIL) >>> 0;
    const reservation = diskBridgeReservation(
      tail,
      tail,
      command.length,
      DISK_BRIDGE_WRITE_ARENA_BYTES,
    );
    const head = Atomics.load(control, DISK_BRIDGE_WRITE_HEAD) >>> 0;
    if (
      reservation === undefined ||
      diskBridgeOccupancy(head, tail) <
        diskBridgeOccupancy(reservation.nextHead, tail) ||
      diskBridgeOccupancy(head, tail) > DISK_BRIDGE_WRITE_ARENA_BYTES
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk write arena is invalid");
    }
    disk.write(
      command.offset,
      this.#views.writeArena.subarray(
        reservation.offset,
        reservation.offset + command.length,
      ),
    );
    Atomics.store(control, DISK_BRIDGE_WRITE_TAIL, reservation.nextHead);
  }

  #read(disk: StorageBridgeDisk, command: Command): void {
    const control = this.#views.control;
    const head = Atomics.load(control, DISK_BRIDGE_READ_HEAD) >>> 0;
    const tail = Atomics.load(control, DISK_BRIDGE_READ_TAIL) >>> 0;
    const reservation = diskBridgeReservation(
      head,
      tail,
      command.length,
      DISK_BRIDGE_READ_ARENA_BYTES,
    );
    if (reservation === undefined) {
      throw new VMError("PROTOCOL_ERROR", "host disk read arena is full");
    }
    disk.read(
      command.offset,
      this.#views.readArena.subarray(
        reservation.offset,
        reservation.offset + command.length,
      ),
    );
    Atomics.store(control, DISK_BRIDGE_READ_HEAD, reservation.nextHead);
    this.#complete(command, DISK_BRIDGE_FAILURE_NONE);
  }

  #complete(command: Command, reason: number): void {
    const control = this.#views.control;
    const head = Atomics.load(control, DISK_BRIDGE_COMPLETION_HEAD) >>> 0;
    const tail = Atomics.load(control, DISK_BRIDGE_COMPLETION_TAIL) >>> 0;
    if (
      diskBridgeOccupancy(head, tail) >= DISK_BRIDGE_COMPLETION_CAPACITY
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk completion ring is full");
    }
    const base = (head % DISK_BRIDGE_COMPLETION_CAPACITY) * DESCRIPTOR_WORDS;
    const completions = this.#views.completions;
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_SEQUENCE, command.sequence);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_REQUEST_ID, command.requestId);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_RESULT, reason === 0 ? 0 : 1);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_LENGTH_LOW, command.length);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_LENGTH_HIGH, 0);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_FAILURE_REASON, reason);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_RESERVED_0, 0);
    Atomics.store(completions, base + DISK_BRIDGE_COMPLETION_RESERVED_1, 0);
    Atomics.store(control, DISK_BRIDGE_COMPLETION_HEAD, (head + 1) >>> 0);
  }

  #serviceSync(notice: Extract<DiskBridgeNotice, { type: "disk-sync" }>): void {
    const control = this.#views.control;
    if (
      Atomics.load(control, DISK_BRIDGE_SYNC_STATE) !==
        DISK_BRIDGE_SYNC_REQUESTED ||
      (Atomics.load(control, DISK_BRIDGE_SYNC_SEQUENCE) >>> 0) !==
        notice.sequence
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk sync state is invalid");
    }
    const barrier = Atomics.load(control, DISK_BRIDGE_SYNC_BARRIER) >>> 0;
    this.#drainUntil(barrier);
    let reason = this.#stickyReason();
    if (
      reason === DISK_BRIDGE_FAILURE_NONE &&
      (Atomics.load(control, DISK_BRIDGE_COMMAND_TAIL) >>> 0) !== barrier
    ) {
      reason = DISK_BRIDGE_FAILURE_PROTOCOL;
    }
    if (reason === DISK_BRIDGE_FAILURE_NONE) {
      try {
        this.#executeSync();
      } catch (error) {
        reason = failureReason(error);
        this.#setSticky(notice.sequence, reason);
      }
    }
    Atomics.store(control, DISK_BRIDGE_SYNC_RESULT, reason);
    Atomics.store(control, DISK_BRIDGE_SYNC_STATE, DISK_BRIDGE_SYNC_RESPONDED);
    Atomics.notify(control, DISK_BRIDGE_SYNC_STATE);
    this.#postProgress();
  }

  #executeSync(): void {
    const disk = this.#disk();
    if (disk === undefined) {
      throw new VMError("STORAGE_ERROR", "managed disk is not prepared");
    }
    const control = this.#views.control;
    const operation = Atomics.load(control, DISK_BRIDGE_SYNC_OPERATION);
    const length = Atomics.load(control, DISK_BRIDGE_SYNC_LENGTH) >>> 0;
    const offset =
      (Atomics.load(control, DISK_BRIDGE_SYNC_OFFSET_HIGH) >>> 0) *
        0x1_0000_0000 +
      (Atomics.load(control, DISK_BRIDGE_SYNC_OFFSET_LOW) >>> 0);
    if (!Number.isSafeInteger(offset)) {
      throw new VMError("PROTOCOL_ERROR", "host disk sync offset is invalid");
    }
    if (operation === DISK_BRIDGE_FLUSH && offset === 0 && length === 0) {
      disk.flush();
      return;
    }
    if (
      operation !== DISK_BRIDGE_READ ||
      length === 0 ||
      length > this.#views.syncWindow.byteLength
    ) {
      throw new VMError("PROTOCOL_ERROR", "host disk sync request is invalid");
    }
    disk.read(offset, this.#views.syncWindow.subarray(0, length));
  }

  #serviceReset(
    notice: Extract<DiskBridgeNotice, { type: "disk-reset" }>,
  ): void {
    let reason = DISK_BRIDGE_FAILURE_NONE;
    try {
      this.#drain();
      reason = this.#stickyReason();
      if (reason !== DISK_BRIDGE_FAILURE_NONE) {
        throw new VMError("STORAGE_ERROR", "host disk generation failed");
      }
      this.#disk()?.flush();
      if (
        this.#commandDepth() !== 0 ||
        diskBridgeOccupancy(
          Atomics.load(this.#views.control, DISK_BRIDGE_COMPLETION_HEAD),
          Atomics.load(
            this.#views.control,
            DISK_BRIDGE_COMPLETION_TAIL,
          ),
        ) !== 0 ||
        (Atomics.load(this.#views.control, DISK_BRIDGE_READ_HEAD) >>> 0) !==
          (Atomics.load(this.#views.control, DISK_BRIDGE_READ_TAIL) >>> 0) ||
        Atomics.load(this.#views.control, DISK_BRIDGE_SYNC_STATE) !==
          DISK_BRIDGE_SYNC_IDLE
      ) {
        throw new VMError("PROTOCOL_ERROR", "host disk reset is not quiescent");
      }
      this.#resetCounters(notice.nextGeneration);
    } catch (error) {
      reason = reason || failureReason(error);
    }
    this.#port.postMessage({
      version: DISK_BRIDGE_VERSION,
      type: "disk-reset-ack",
      generation: notice.generation,
      nextGeneration: notice.nextGeneration,
      ok: reason === DISK_BRIDGE_FAILURE_NONE,
      reason,
    } satisfies DiskBridgeReply);
  }

  #resetCounters(generation: number): void {
    const control = this.#views.control;
    for (const index of [
      DISK_BRIDGE_COMMAND_HEAD,
      DISK_BRIDGE_COMMAND_TAIL,
      DISK_BRIDGE_COMPLETION_HEAD,
      DISK_BRIDGE_COMPLETION_TAIL,
      DISK_BRIDGE_WRITE_HEAD,
      DISK_BRIDGE_WRITE_TAIL,
      DISK_BRIDGE_READ_HEAD,
      DISK_BRIDGE_READ_TAIL,
      DISK_BRIDGE_KICK_PENDING,
      DISK_BRIDGE_STICKY_SEQUENCE,
      DISK_BRIDGE_STICKY_REASON,
      DISK_BRIDGE_SYNC_STATE,
    ]) {
      Atomics.store(control, index, 0);
    }
    Atomics.store(control, DISK_BRIDGE_GENERATION, generation);
    this.#lastCommandSequence = 0;
  }

  #fail(sequence: number, reason: number): void {
    this.#setSticky(sequence, reason);
    const control = this.#views.control;
    Atomics.store(
      control,
      DISK_BRIDGE_COMMAND_TAIL,
      Atomics.load(control, DISK_BRIDGE_COMMAND_HEAD),
    );
    Atomics.store(
      control,
      DISK_BRIDGE_WRITE_TAIL,
      Atomics.load(control, DISK_BRIDGE_WRITE_HEAD),
    );
    Atomics.store(control, DISK_BRIDGE_KICK_PENDING, 0);
  }

  #setSticky(sequence: number, reason: number): void {
    const control = this.#views.control;
    if (Atomics.load(control, DISK_BRIDGE_STICKY_SEQUENCE) !== 0) return;
    Atomics.store(control, DISK_BRIDGE_STICKY_REASON, reason);
    Atomics.compareExchange(
      control,
      DISK_BRIDGE_STICKY_SEQUENCE,
      0,
      sequence || 1,
    );
  }

  #stickyReason(): number {
    if (
      Atomics.load(this.#views.control, DISK_BRIDGE_STICKY_SEQUENCE) === 0
    ) {
      return DISK_BRIDGE_FAILURE_NONE;
    }
    const reason = Atomics.load(
      this.#views.control,
      DISK_BRIDGE_STICKY_REASON,
    );
    return reason === DISK_BRIDGE_FAILURE_BACKEND ||
      reason === DISK_BRIDGE_FAILURE_PROTOCOL ||
      reason === DISK_BRIDGE_FAILURE_QUOTA
      ? reason
      : DISK_BRIDGE_FAILURE_PROTOCOL;
  }

  #commandDepth(): number {
    const depth = diskBridgeOccupancy(
      Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_HEAD),
      Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_TAIL),
    );
    if (depth > DISK_BRIDGE_COMMAND_CAPACITY) {
      throw new VMError("PROTOCOL_ERROR", "host disk command ring overflowed");
    }
    return depth;
  }

  #generation(): number {
    return Atomics.load(this.#views.control, DISK_BRIDGE_GENERATION) >>> 0;
  }

  #nextCommandSequence(): number {
    const tail = Atomics.load(
      this.#views.control,
      DISK_BRIDGE_COMMAND_TAIL,
    ) >>> 0;
    const base = (tail % DISK_BRIDGE_COMMAND_CAPACITY) * DESCRIPTOR_WORDS;
    return (
      Atomics.load(
        this.#views.commands,
        base + DISK_BRIDGE_DESCRIPTOR_SEQUENCE,
      ) >>> 0
    ) || 1;
  }

  #postProgress(): void {
    this.#port.postMessage({
      version: DISK_BRIDGE_VERSION,
      type: "disk-progress",
      generation: this.#generation(),
      commandTail:
        Atomics.load(this.#views.control, DISK_BRIDGE_COMMAND_TAIL) >>> 0,
      completionHead:
        Atomics.load(this.#views.control, DISK_BRIDGE_COMPLETION_HEAD) >>> 0,
    } satisfies DiskBridgeReply);
  }
}

function validCommand(operation: number, offset: number, length: number): boolean {
  if (operation === DISK_BRIDGE_FLUSH) return offset === 0 && length === 0;
  return (
    (operation === DISK_BRIDGE_READ ||
      operation === DISK_BRIDGE_WRITE ||
      operation === DISK_BRIDGE_ZERO) &&
    length > 0
  );
}

function failureReason(error: unknown): number {
  if (error instanceof VMError) {
    if (error.code === "PROTOCOL_ERROR") return DISK_BRIDGE_FAILURE_PROTOCOL;
    return error.code === "QUOTA_EXCEEDED" ? DISK_BRIDGE_FAILURE_QUOTA : DISK_BRIDGE_FAILURE_BACKEND;
  }
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? DISK_BRIDGE_FAILURE_QUOTA
    : DISK_BRIDGE_FAILURE_BACKEND;
}

function nextSequence(value: number): number {
  const next = ((value >>> 0) + 1) >>> 0;
  return next === 0 ? 1 : next;
}
