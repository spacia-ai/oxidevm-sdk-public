import { exactKeys, record } from "./decode.js";
import { decodeSerializedError, deserializeError, serializeUnknownError, type SerializedError, VMError } from "./errors.js";
import { validateWorkspaceId, workspaceLockName } from "./workspace-path.js";

/** The version of the messages tabs exchange to hand a workspace over; tabs ignore other versions. */
export const WORKSPACE_HANDOFF_VERSION = 2;
/** How long an asking tab waits for the tab that holds the workspace to answer. */
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_TIMEOUT_MILLISECONDS = 10 * 60_000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type {WorkspaceHandoffResult,WorkspaceHandoffOptions,WorkspaceMovedAway} from "./workspace-handoff-types.js";
import type {WorkspaceHandoffResult,WorkspaceHandoffOptions,WorkspaceMovedAway} from "./workspace-handoff-types.js";

type HandoffMessage =
  | { readonly type: "handoff-request" | "handoff-accepted"; readonly requestId: string }
  | { readonly type: "handoff-failed"; readonly requestId: string; readonly error: SerializedError };

/** The channel tabs ask each other for `workspaceId` on. */
export function workspaceHandoffChannelName(workspaceId: string): string {
  return `oxidevm-workspace-handoff-${workspaceId}`;
}

/**
 * Asks the tab whose VM holds `workspaceId` to hand it over, and waits until the workspace is
 * free. A free workspace is released at once. A tab that answers saves its VM and stops it,
 * which may outlast the timeout; without an answer within `timeoutMs` the result is
 * "no-response" and the workspace is left alone. A failed save rejects with the holder's
 * typed error; the holder keeps running and can answer a later request.
 */
export async function requestWorkspaceHandoff(
  workspaceId: string,
  options: WorkspaceHandoffOptions = {},
): Promise<WorkspaceHandoffResult> {
  const id = validateWorkspaceId(workspaceId);
  const timeout = validateTimeout(options.timeoutMs);
  const signal = options.signal;
  if (signal?.aborted === true) throw cancelled();
  if (await lockIsFree(id)) return "released";
  return new Promise<WorkspaceHandoffResult>((resolve, reject) => {
    const channel = new BroadcastChannel(workspaceHandoffChannelName(id));
    const waiting = new AbortController();
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.close();
      signal?.removeEventListener("abort", onAbort);
      // Withdraws the lock request when the workspace was not released.
      waiting.abort();
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(cancelled());
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        resolve("no-response");
      });
    }, timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = decodeHandoffMessage(event.data);
      // The holder answered: it is saving and stopping, so wait for it however long that takes.
      if (message === undefined || message.requestId !== requestId) return;
      if (message.type === "handoff-accepted") clearTimeout(timer);
      if (message.type === "handoff-failed") finish(() => { reject(deserializeError(message.error)); });
    });
    navigator.locks.request(workspaceLockName(id), { mode: "exclusive", signal: waiting.signal }, () => undefined).then(
      () => {
        finish(() => {
          resolve("released");
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof VMError ? error : new VMError("STORAGE_ERROR", "the workspace lock could not be requested"));
        });
      },
    );
    channel.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId });
  });
}

/**
 * Answers the first tab that asks for `workspaceId` while `signal` is not aborted: accepts its
 * request, then runs `handOff`, which saves and stops the VM, freeing the workspace. A failed
 * save is reported to the requester and leaves this listener ready for another request.
 */
export function listenForWorkspaceHandoff(workspaceId: string, handOff: () => Promise<void>, signal: AbortSignal): void {
  if (signal.aborted) return;
  const channel = new BroadcastChannel(workspaceHandoffChannelName(validateWorkspaceId(workspaceId)));
  let handingOff = false;
  const stop = (): void => {
    // Revocation stops new requests; an accepted request still needs its outcome.
    if (!handingOff) channel.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = decodeHandoffMessage(event.data);
    if (message?.type !== "handoff-request" || handingOff || signal.aborted) return;
    handingOff = true;
    channel.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-accepted", requestId: message.requestId });
    void Promise.resolve().then(handOff).then(
      () => {
        handingOff = false;
        signal.removeEventListener("abort", stop);
        stop();
      },
      (error: unknown) => {
        handingOff = false;
        channel.postMessage({
          version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId: message.requestId,
          error: serializeUnknownError(error),
        });
        if (signal.aborted) stop();
      },
    );
  });
}

/**
 * What `RuntimeVM.allowWorkspaceHandoff` does for either kind of VM: until `options.signal` or the
 * VM's `lifetime` aborts, the first tab that asks gets the workspace: `handOff` saves and stops
 * the VM, then `onMovedAway` hears how that went.
 */
export function allowWorkspaceHandoff(
  workspaceId: string,
  lifetime: AbortSignal,
  handOff: () => Promise<WorkspaceMovedAway>,
  onMovedAway: (moved: WorkspaceMovedAway) => void,
  options: { readonly signal: AbortSignal },
): void {
  const signal = validateHandoffRegistration(onMovedAway, options);
  if (lifetime.aborted) throw new VMError("ABORTED", "the VM was disposed");
  listenForWorkspaceHandoff(workspaceId, async () => {
    const moved = await handOff();
    queueMicrotask(() => {
      onMovedAway(moved);
    });
  }, AbortSignal.any([signal, lifetime]));
}

/** Validates original public arguments before an adapter wraps the listener or combines signals. */
export function validateHandoffRegistration(listener: unknown, options: unknown): AbortSignal {
  try {
    const given = record(options, "workspace handoff options");
    exactKeys(given, ["signal"]);
    const signal = given["signal"];
    if (typeof listener === "function" && signal instanceof AbortSignal) return signal;
  } catch {
    // Public argument failures use INVALID_ARGUMENT rather than protocol decoder errors.
  }
  throw new VMError("INVALID_ARGUMENT", "allowing workspace handoffs takes a listener and only an AbortSignal option");
}

/** Whether `workspaceId` is free, taking and dropping its lock if so. */
async function lockIsFree(workspaceId: string): Promise<boolean> {
  return navigator.locks.request(workspaceLockName(workspaceId), { mode: "exclusive", ifAvailable: true }, (lock) => lock !== null);
}

/**
 * A handoff message of this version, or undefined for anything else on the channel: other tabs
 * of another version share it and must not stop or start a handoff.
 */
function decodeHandoffMessage(value: unknown): HandoffMessage | undefined {
  let message: Readonly<Record<string, unknown>>;
  try {
    message = record(value, "workspace handoff message");
    exactKeys(message, message["type"] === "handoff-failed" ? ["version", "type", "requestId", "error"] : ["version", "type", "requestId"]);
  } catch {
    return undefined;
  }
  const type = message["type"];
  const requestId = message["requestId"];
  if (
    message["version"] !== WORKSPACE_HANDOFF_VERSION ||
    (type !== "handoff-request" && type !== "handoff-accepted" && type !== "handoff-failed") ||
    typeof requestId !== "string" ||
    !REQUEST_ID.test(requestId)
  ) {
    return undefined;
  }
  if (type === "handoff-failed") {
    try {
      return { type, requestId, error: decodeSerializedError(message["error"]) };
    } catch {
      return undefined;
    }
  }
  return { type, requestId };
}

function validateTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MILLISECONDS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MILLISECONDS) {
    throw new VMError("INVALID_ARGUMENT", `timeoutMs must be an integer from 1 to ${String(MAX_TIMEOUT_MILLISECONDS)}`);
  }
  return value;
}

function cancelled(): VMError {
  return new VMError("ABORTED", "the workspace handoff was cancelled");
}
