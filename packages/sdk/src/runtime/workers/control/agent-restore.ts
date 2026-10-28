import { integer } from "../../decode.js";
import { VMError, serializeUnknownError } from "../../errors.js";
import type { WorkspaceRestore } from "../../protocol.js";
import type { RestoreStatus, WorkspaceRestoreTarget } from "../../protocol/workspace-restore.js";
import type { WorkspaceStreamInput, WorkspaceStreamProducer } from "../workspace-stream.js";

export interface GuestRestoreTransfer {
  readonly transfer: number;
  /** "current": Linux already holds this dependency generation; nothing streams. */
  readonly ready: Promise<"receive" | "current">;
  readonly send: (workerRequestId: number, operation: WorkspaceRestore) => Promise<void>;
  /** How far the committed apply has progressed; the guest answers each
   * request within its own deadline while the apply runs on its own thread. */
  readonly status: (workerRequestId: number) => Promise<RestoreStatus>;
}

/** How the apply's completion is awaited: one status request per `pollMs`,
 * and a failure once `stallMs` pass without the applied count advancing. A
 * large tree may take minutes; only a guest that stops making progress fails. */
export interface RestoreApplyPacing {
  readonly pollMs: number;
  readonly stallMs: number;
}

const DEFAULT_PACING: RestoreApplyPacing = { pollMs: 250, stallMs: 60_000 };

/** Chunk requests kept in flight: the console transport of one chunk overlaps
 * the guest's verify-and-write of the previous ones. Requests still arrive in
 * offset order, which the guest's receiver requires. */
const CHUNK_WINDOW = 4;

interface ActiveRestore {
  readonly workerRequestId: number;
  readonly cancellation: AbortController;
  readonly retire: () => Promise<void>;
  transfer?: GuestRestoreTransfer;
  abort?: Promise<void>;
  transportFailure?: Error;
}

/** Stream retirement and guest commit are separate acknowledgements. Neither
 * EOF nor a successfully sent commit authorizes subsequent workspace use. */
export class AgentRestore {
  #active: ActiveRestore | undefined;

  constructor(
    private readonly open: (workerRequestId: number, format: WorkspaceRestoreTarget, bytes: number) => GuestRestoreTransfer,
    private readonly failed: (error: unknown) => unknown,
    private readonly pacing: RestoreApplyPacing = DEFAULT_PACING,
    private readonly inspectHeader?: (format: WorkspaceRestoreTarget, header: Uint8Array<ArrayBuffer>) => void,
  ) {}

  cancel(workerRequestId?: number): void {
    const active = this.#active;
    if (active === undefined || (workerRequestId !== undefined && active.workerRequestId !== workerRequestId)) return;
    active.cancellation.abort();
    void active.retire().catch(() => {});
    void this.abort(active).catch(() => {});
  }

  stop(error: unknown): void {
    if (this.#active === undefined) return;
    this.#active.transportFailure = error instanceof Error ? error
      : new VMError("GUEST_CRASH", "Guest restore transport failed", { cause: serializeUnknownError(error) });
    this.cancel();
  }

  async apply(workerRequestId: number, format: WorkspaceRestoreTarget, input: WorkspaceStreamInput, validateHeader?: (header: Uint8Array) => void): Promise<void> {
    if (this.#active !== undefined) throw new VMError("INVALID_ARGUMENT", "Workspace restoration is already active");
    integer(input.bytes, "workspace restore bytes", 12, 1024 ** 4);
    let producer: WorkspaceStreamProducer | undefined;
    let retirement: Promise<void> | undefined;
    const active: ActiveRestore = { workerRequestId, cancellation: new AbortController(),
      retire: () => retirement ??= Promise.resolve().then(() => producer?.retire()) };
    this.#active = active;
    let opened = false;
    let committing = false;
    const check = (): void => {
      if (active.cancellation.signal.aborted) throw new VMError("ABORTED", "Workspace restoration cancelled");
    };
    try {
      producer = input.source(active.cancellation.signal);
      check();
      opened = true;
      active.transfer = this.open(workerRequestId, format, input.bytes);
      const begun = await active.transfer.ready;
      check();
      if (begun === "current") {
        // No native transfer opened; the producer is retired unread.
        await active.retire();
        return;
      }
      let offset = 0;
      const header = new Uint8Array(12);
      let headerBytes = 0;
      const inFlight: Promise<void>[] = [];
      const settle = async (limit: number): Promise<void> => {
        while (inFlight.length > limit) {
          const oldest = inFlight.shift();
          if (oldest !== undefined) await oldest;
        }
      };
      for await (const frame of producer.frames) {
        check();
        if (!(frame instanceof Uint8Array) || !(frame.buffer instanceof ArrayBuffer)
          || frame.byteOffset !== 0 || frame.buffer.byteLength !== frame.byteLength
          || frame.byteLength === 0 || frame.byteLength > 65_536 || offset + frame.byteLength > input.bytes) {
          throw new VMError("PROTOCOL_ERROR", "Workspace restore producer exceeded its declared bounds");
        }
        const data = new Uint8Array(frame);
        if (headerBytes < header.length) {
          const take = Math.min(header.length - headerBytes, data.length);
          header.set(data.subarray(0, take), headerBytes);
          headerBytes += take;
          if (headerBytes === header.length) {
            this.inspectHeader?.(format, header);
            validateHeader?.(header);
          }
        }
        const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
        check();
        const sending = active.transfer.send(workerRequestId, { kind: "chunk", transfer: active.transfer.transfer, offset, sha256, data });
        // The oldest send is awaited in order; a later rejection still reaches
        // that await, so the derived handler only keeps it from being unhandled.
        void sending.catch(() => undefined);
        inFlight.push(sending);
        offset += data.byteLength;
        await settle(CHUNK_WINDOW - 1);
      }
      await settle(0);
      if (offset !== input.bytes) throw new VMError("PROTOCOL_ERROR", "Workspace restore producer ended early");
      await active.retire();
      check();
      committing = true;
      await active.transfer.send(workerRequestId, { kind: "commit", transfer: active.transfer.transfer });
      await this.awaitApplied(active.transfer, workerRequestId, check);
    } catch (error) {
      active.cancellation.abort();
      const cleanup = await Promise.allSettled([active.retire(), this.abort(active)]);
      if (committing || (opened && active.transfer === undefined) || cleanup.some(result => result.status === "rejected")) {
        throw this.failed(error);
      }
      throw error;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  /** Polls the guest until the committed apply ends. Progress, not time,
   * bounds the wait: a status whose applied count has not advanced for
   * `stallMs` fails the restore; a guest that keeps applying is never cut. */
  private async awaitApplied(transfer: GuestRestoreTransfer, workerRequestId: number, check: () => void): Promise<void> {
    let applied = -1;
    let advancedAt = performance.now();
    for (;;) {
      check();
      const status = await transfer.status(workerRequestId);
      if (status.state === "done") return;
      if (status.state === "failed") {
        throw new VMError("GUEST_CRASH", `Workspace restore apply failed: ${status.error}`, { applied: status.applied, total: status.total });
      }
      const now = performance.now();
      if (status.applied !== applied) { applied = status.applied; advancedAt = now; }
      else if (now - advancedAt >= this.pacing.stallMs) {
        throw new VMError("GUEST_CRASH", "Workspace restore apply stalled", { applied: status.applied, total: status.total, stallMs: this.pacing.stallMs });
      }
      await new Promise<void>(resolve => { setTimeout(resolve, this.pacing.pollMs); });
    }
  }

  private abort(active: ActiveRestore): Promise<void> {
    if (active.transportFailure !== undefined) return Promise.reject(active.transportFailure);
    const transfer = active.transfer;
    if (transfer === undefined) return Promise.resolve();
    // Cleanup uses the unowned control request ID, independent of the cancelled
    // caller. Native transfer identity still pins the operation to this spool.
    return active.abort ??= Promise.resolve().then(() => transfer.send(0, { kind: "abort", transfer: transfer.transfer }));
  }
}
