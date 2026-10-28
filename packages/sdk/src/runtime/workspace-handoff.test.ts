import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listenForWorkspaceHandoff,
  requestWorkspaceHandoff,
  WORKSPACE_HANDOFF_VERSION,
  workspaceHandoffChannelName,
} from "./workspace-handoff.js";
import { VMError } from "./errors.js";
import { workspaceLockName } from "./workspace-path.js";

let sequence = 0;

/** A workspace no other test uses, so locks and channels never cross tests. */
function workspace(): string {
  sequence += 1;
  return `handoff-${String(sequence)}-${Date.now().toString(36)}`;
}

/** Holds the workspace's lock, as a VM's storage worker does, until the returned release. */
async function hold(workspaceId: string): Promise<() => void> {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((granted) => {
    void navigator.locks.request(workspaceLockName(workspaceId), { mode: "exclusive" }, async () => {
      granted();
      await held;
    });
  });
  return release;
}

/**
 * The abort signal of each lock request made from now on. Node lists a withdrawn request as
 * pending until the lock is released, so tests check that the request was withdrawn.
 */
function lockRequestSignals(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  const locks = navigator.locks;
  const request = locks.request.bind(locks);
  vi.spyOn(locks, "request").mockImplementation((name, options, callback) => {
    if (options.signal !== undefined) signals.push(options.signal);
    return request(name, options, callback);
  });
  return signals;
}

/** Lets messages between channels arrive (fake timers leave setImmediate real). */
async function deliver(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("workspace handoff between tabs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("releases a free workspace at once, without asking other tabs", async () => {
    const id = workspace();
    const handOff = vi.fn(() => Promise.resolve());
    const listening = new AbortController();
    listenForWorkspaceHandoff(id, handOff, listening.signal);

    await expect(requestWorkspaceHandoff(id)).resolves.toBe("released");
    await deliver();

    expect(handOff).not.toHaveBeenCalled();
    listening.abort();
  });

  it("asks the tab that holds the workspace, which hands it over", async () => {
    const id = workspace();
    const release = await hold(id);
    const handOff = vi.fn(() => {
      release();
      return Promise.resolve();
    });
    listenForWorkspaceHandoff(id, handOff, new AbortController().signal);

    await expect(requestWorkspaceHandoff(id)).resolves.toBe("released");

    expect(handOff).toHaveBeenCalledTimes(1);
  });

  it("returns a typed save failure to the requester and withdraws its lock request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = workspace();
    const release = await hold(id);
    const signals = lockRequestSignals();
    const holder = new BroadcastChannel(workspaceHandoffChannelName(id));
    holder.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "object" || event.data === null || !("requestId" in event.data)) return;
      holder.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId: event.data.requestId,
        error: { code: "QUOTA_EXCEEDED", message: "the browser has no room" } });
    });
    const outcome = requestWorkspaceHandoff(id).catch((error: unknown) => error);
    await deliver();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    holder.close();
    release();

    expect(result).toMatchObject({ code: "QUOTA_EXCEEDED", message: "the browser has no room" });
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("keeps the holder and its listener after failure, and accepts a successful retry", async () => {
    const id = workspace();
    const release = await hold(id);
    const listening = new AbortController();
    let attempts = 0;
    const handOff = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new VMError("STORAGE_ERROR", "save failed"));
      release();
      return Promise.resolve();
    });
    listenForWorkspaceHandoff(id, handOff, listening.signal);
    try {
      await expect(requestWorkspaceHandoff(id)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
      const free = await navigator.locks.request(workspaceLockName(id), { ifAvailable: true }, (lock) => lock !== null);
      expect(free).toBe(false);
      await expect(requestWorkspaceHandoff(id)).resolves.toBe("released");
      expect(handOff).toHaveBeenCalledTimes(2);
    } finally {
      listening.abort();
      release();
    }
  });

  it("replies to an accepted save failure after the holder withdraws permission", async () => {
    const id = workspace();
    const release = await hold(id);
    const signals = lockRequestSignals();
    const listening = new AbortController();
    const requesting = new AbortController();
    const saving = Promise.withResolvers<undefined>();
    const handOff = vi.fn(() => saving.promise);
    listenForWorkspaceHandoff(id, handOff, listening.signal);
    let failure: unknown;
    const outcome = requestWorkspaceHandoff(id, { signal: requesting.signal }).catch((error: unknown) => { failure = error; });
    try {
      await deliver();
      expect(handOff).toHaveBeenCalledTimes(1);
      listening.abort();
      saving.reject(new VMError("STORAGE_ERROR", "save failed"));
      await deliver();
      expect(failure).toMatchObject({ code: "STORAGE_ERROR", message: "save failed" });
      expect(signals.map((signal) => signal.aborted)).toEqual([true]);
      const free = await navigator.locks.request(workspaceLockName(id), { ifAvailable: true }, (lock) => lock !== null);
      expect(free).toBe(false);
    } finally {
      requesting.abort();
      listening.abort();
      release();
      await outcome;
    }
  });

  it("does not start a second handoff while the first saves", async () => {
    const id = workspace();
    const listening = new AbortController();
    const saving = Promise.withResolvers<undefined>();
    const handOff = vi.fn(() => saving.promise);
    listenForWorkspaceHandoff(id, handOff, listening.signal);
    const requester = new BroadcastChannel(workspaceHandoffChannelName(id));
    requester.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId: "123e4567-e89b-42d3-a456-426614174000" });
    requester.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId: "123e4567-e89b-42d3-a456-426614174001" });
    await deliver();
    expect(handOff).toHaveBeenCalledTimes(1);
    saving.resolve(undefined);
    await deliver();
    requester.close();
    listening.abort();
  });

  it("ignores invalid or mismatched failures and accepts the validated failure", async () => {
    const id = workspace();
    const release = await hold(id);
    const holder = new BroadcastChannel(workspaceHandoffChannelName(id));
    let requestId: unknown;
    holder.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data === "object" && event.data !== null && "requestId" in event.data) requestId = event.data.requestId;
    });
    let settled = false;
    const outcome = requestWorkspaceHandoff(id).then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await deliver();
    const error = { code: "STORAGE_ERROR", message: "save failed" };
    for (const message of [
      { version: 1, type: "handoff-failed", requestId, error },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId, error: { ...error, extra: true } },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId, error: { ...error, code: "unknown" } },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId, error: { ...error, message: 123 } },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId, error, extra: true },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId: "123e4567-e89b-42d3-a456-426614174000", error },
    ]) holder.postMessage(message);
    await deliver();
    expect(settled).toBe(false);
    holder.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId, error });
    const result = await outcome;
    holder.close();
    release();
    expect(result).toBeInstanceOf(VMError);
    expect(result).toMatchObject(error);
  });

  it("reports no response when no tab answers within ten seconds, and stops waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = workspace();
    const release = await hold(id);
    const signals = lockRequestSignals();
    let result: string | undefined;

    void requestWorkspaceHandoff(id).then((outcome) => {
      result = outcome;
    });
    await deliver();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await deliver();

    expect(result).toBe("no-response");
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    release();
  });

  it("waits past the timeout for a tab that answered and is still saving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = workspace();
    const release = await hold(id);
    let finishSaving = (): void => undefined;
    const handOff = vi.fn(() => new Promise<void>((resolve) => {
      finishSaving = () => {
        release();
        resolve();
      };
    }));
    listenForWorkspaceHandoff(id, handOff, new AbortController().signal);

    const result = requestWorkspaceHandoff(id, { timeoutMs: 1_000 });
    await deliver();
    expect(handOff).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    finishSaving();

    await expect(result).resolves.toBe("released");
  });

  it("stops waiting when the caller cancels", async () => {
    const id = workspace();
    const release = await hold(id);
    const signals = lockRequestSignals();
    const cancel = new AbortController();

    const result = requestWorkspaceHandoff(id, { signal: cancel.signal });
    await deliver();
    cancel.abort();

    await expect(result).rejects.toMatchObject({ code: "ABORTED" });
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    release();
  });

  it("does not hand over for messages that are not a request it knows", async () => {
    const id = workspace();
    const release = await hold(id);
    const handOff = vi.fn(() => Promise.resolve());
    listenForWorkspaceHandoff(id, handOff, new AbortController().signal);
    const otherTab = new BroadcastChannel(workspaceHandoffChannelName(id));
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    for (const message of [
      { version: WORKSPACE_HANDOFF_VERSION - 1, type: "handoff-request", requestId },
      { version: WORKSPACE_HANDOFF_VERSION + 1, type: "handoff-request", requestId },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId, extra: true },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId: "not-a-uuid" },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-take", requestId },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-accepted", requestId },
      "handoff-request",
    ]) {
      otherTab.postMessage(message);
    }
    await deliver();

    expect(handOff).not.toHaveBeenCalled();
    otherTab.close();
    release();
  });

  it("keeps the timeout when a tab accepts some other request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = workspace();
    const release = await hold(id);
    const otherTab = new BroadcastChannel(workspaceHandoffChannelName(id));
    otherTab.addEventListener("message", () => {
      otherTab.postMessage({
        version: WORKSPACE_HANDOFF_VERSION,
        type: "handoff-accepted",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      });
    });

    const result = requestWorkspaceHandoff(id);
    await deliver();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe("no-response");
    otherTab.close();
    release();
  });

  it("does not answer once the page stops allowing handoffs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = workspace();
    const release = await hold(id);
    const handOff = vi.fn(() => Promise.resolve());
    const allowing = new AbortController();
    listenForWorkspaceHandoff(id, handOff, allowing.signal);
    allowing.abort();

    const result = requestWorkspaceHandoff(id);
    await deliver();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe("no-response");
    expect(handOff).not.toHaveBeenCalled();
    release();
  });

  it("refuses an invalid workspace or timeout", async () => {
    await expect(requestWorkspaceHandoff("../other")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(requestWorkspaceHandoff(workspace(), { timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(requestWorkspaceHandoff(workspace(), { timeoutMs: 1.5 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
