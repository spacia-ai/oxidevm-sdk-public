import { VMError, deserializeError } from "../../runtime/errors.js";
import { decodeFrameReply } from "../protocol/replies.js";
import { frameRequest } from "../protocol/requests.js";
import type { FrameOperation } from "../protocol/requests.js";
import { FRAME_PROTOCOL_VERSION } from "../protocol/handshake.js";
import { keeperReport } from "../protocol/keepers.js";
import type { KeeperCommand } from "../protocol/keepers.js";

// The page's side of the connected port: one pending entry per request, events routed to the
// request that asked for them, and cancellation sent as `{ type: "cancel", id }`. A lost or
// garbled port fails every pending request and every later one with PROTOCOL_ERROR.

export interface FrameCall<T> {
  readonly decode: (value: unknown) => T;
  /** Receives each event of the request; a throw fails the request as a protocol error. */
  readonly onEvent?: (event: unknown) => void;
  readonly signal?: AbortSignal | undefined;
  readonly transfer?: readonly Transferable[];
  /**
   * What aborting does: "reject" (the default) fails with ABORTED; "resolve" ends a subscription
   * normally with `undefined`, as `watch` methods do when their signal aborts.
   */
  readonly onAbort?: "reject" | "resolve";
  /** Receives the request's id once it is sent, for later requests that name it. */
  readonly onSent?: (id: number) => void;
}

interface Pending {
  readonly onEvent: ((event: unknown) => void) | undefined;
  settle(outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error }): void;
}

export class FrameChannel {
  readonly #port: MessagePort;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #failure: VMError | undefined;

  readonly #onKeeper: ((command: KeeperCommand, ports: readonly MessagePort[]) => void) | undefined;

  /** `onKeeper` receives the frame's preview keeper commands with the ports they carry. */
  constructor(port: MessagePort, onKeeper?: (command: KeeperCommand, ports: readonly MessagePort[]) => void) {
    this.#port = port;
    this.#onKeeper = onKeeper;
    port.addEventListener("message", this.#onMessage);
    port.addEventListener("messageerror", this.#onBroken);
    // Chromium reports a port whose other side went away; elsewhere a removed frame is noticed
    // by the caller that removes it.
    port.addEventListener("close", this.#onBroken);
    port.start();
  }

  /** Why the channel stopped, if it did. */
  get failure(): VMError | undefined { return this.#failure; }

  request<T>(operation: FrameOperation, call: FrameCall<T>): Promise<T> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (call.signal?.aborted === true) return call.onAbort === "resolve" ? Promise.resolve(call.decode(undefined)) : Promise.reject(aborted());
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        call.signal?.removeEventListener("abort", abort);
        this.#post({ v: FRAME_PROTOCOL_VERSION, type: "cancel", id }, []);
        if (call.onAbort === "resolve") settleDecoded(undefined); else reject(aborted());
      };
      const settleDecoded = (value: unknown) => {
        try { resolve(call.decode(value)); } catch (error: unknown) { reject(asProtocolError(error)); }
      };
      this.#pending.set(id, {
        onEvent: call.onEvent,
        settle: outcome => {
          call.signal?.removeEventListener("abort", abort);
          if (outcome.ok) settleDecoded(outcome.value); else reject(outcome.error);
        },
      });
      call.signal?.addEventListener("abort", abort, { once: true });
      this.#post(frameRequest(id, operation), call.transfer ?? []);
      if (this.#pending.has(id)) call.onSent?.(id);
    });
  }

  /** Relays what a preview keeper the page embeds for the frame said. */
  reportKeeper(keeper: number, origin: string, data: unknown): void {
    if (this.#failure === undefined) this.#post(keeperReport(keeper, origin, data), []);
  }

  /** Fails every pending request and stops listening; later requests fail at once. */
  close(reason: VMError = new VMError("PROTOCOL_ERROR", "the runtime frame was closed")): void {
    this.#fail(reason);
    this.#port.close();
  }

  #post(message: Readonly<Record<string, unknown>>, transfer: readonly Transferable[]): void {
    try { this.#port.postMessage(message, [...transfer]); }
    catch (error: unknown) { this.#fail(new VMError("PROTOCOL_ERROR", "the runtime frame cannot receive this request", { cause: describe(error) })); }
  }

  readonly #onMessage = (event: MessageEvent): void => {
    let reply;
    try { reply = decodeFrameReply(event.data); }
    catch (error: unknown) { this.#fail(asProtocolError(error)); return; }
    if (reply.type === "keeper") {
      if (this.#onKeeper === undefined) { this.#fail(new VMError("PROTOCOL_ERROR", "the frame opened a preview keeper this page did not offer")); return; }
      try { this.#onKeeper(reply, event.ports); } catch (error: unknown) { this.#fail(asProtocolError(error)); }
      return;
    }
    const pending = this.#pending.get(reply.id);
    // A reply to a request this page already gave up on (cancelled or aborted) is expected.
    if (pending === undefined) return;
    if (reply.type === "event") {
      try { pending.onEvent?.(reply.event); }
      catch (error: unknown) {
        this.#pending.delete(reply.id);
        this.#post({ v: FRAME_PROTOCOL_VERSION, type: "cancel", id: reply.id }, []);
        pending.settle({ ok: false, error: asProtocolError(error) });
      }
      return;
    }
    this.#pending.delete(reply.id);
    pending.settle(reply.ok ? { ok: true, value: reply.value } : { ok: false, error: deserializeError(reply.error) });
  };

  readonly #onBroken = (): void => { this.#fail(new VMError("PROTOCOL_ERROR", "the runtime frame stopped answering")); };

  #fail(reason: VMError): void {
    if (this.#failure !== undefined) return;
    this.#failure = reason;
    this.#port.removeEventListener("message", this.#onMessage);
    this.#port.removeEventListener("messageerror", this.#onBroken);
    this.#port.removeEventListener("close", this.#onBroken);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.settle({ ok: false, error: reason });
  }
}

function aborted(): VMError {
  return new VMError("ABORTED", "operation was aborted");
}

function asProtocolError(error: unknown): VMError {
  if (error instanceof VMError) return error.code === "PROTOCOL_ERROR" ? error : new VMError("PROTOCOL_ERROR", error.message, error.detail);
  return new VMError("PROTOCOL_ERROR", describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
