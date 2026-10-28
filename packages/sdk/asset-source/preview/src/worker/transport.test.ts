import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTACH_WAIT_MS, HEAD_WAIT_MS, LIVENESS_INTERVAL_MS, RequestInbox, SessionTransport, type KeeperClient, type KeeperDirectory } from "./transport";

const SESSION = "0123456789abcdef0123456789abcdef";

function fakeKeeper(id: string): KeeperClient & { readonly messages: unknown[] } {
  const messages: unknown[] = [];
  return { id, messages, postMessage: (message) => { messages.push(message); } };
}

function directory(keepers: readonly KeeperClient[], open: (id: string) => boolean = (id) => keepers.some((keeper) => keeper.id === id)): KeeperDirectory {
  return {
    keepers: (session) => Promise.resolve(session === SESSION ? keepers : []),
    isOpen: (id) => Promise.resolve(open(id)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("cancels upstream and wakes a pending response when the request body fails", async () => {
  const { port1, port2 } = new MessageChannel();
  const signal = new AbortController();
  const inbox = new RequestInbox(port1, signal.signal);
  const cancelled = new Promise<unknown>(resolve => { port2.onmessage = (event: MessageEvent<unknown>) => resolve(event.data); });
  const pending = inbox.next();
  inbox.failRequestBody();
  await expect(pending).resolves.toEqual({ kind: "error", code: "request-body", reason: "read" });
  await expect(cancelled).resolves.toEqual({ kind: "cancel" });
  inbox.close();
  signal.abort();
  port2.close();
});

it("consumes upload acknowledgements before reading the response head", async () => {
  const { port1, port2 } = new MessageChannel();
  const inbox = new RequestInbox(port1, new AbortController().signal);
  const acknowledgement = { kind: "body-ack", sequence: 1 };
  const header = { kind: "response", status: 200 };
  const body = Promise.resolve().then(() => inbox.next()).then(value => { expect(value).toEqual(acknowledgement); });
  void body.catch(() => {});
  const response = inbox.responseHead(body);
  port2.postMessage(acknowledgement);
  port2.postMessage(header);
  try { await expect(response).resolves.toEqual(header); }
  finally { inbox.close(); port2.close(); }
});

it("wakes pending body reads on closure and keeps the closed result persistent", async () => {
  const { port1, port2 } = new MessageChannel();
  const inbox = new RequestInbox(port1, new AbortController().signal);
  const pending = inbox.next();
  inbox.close();
  const failure = { kind: "error", code: "request-body", reason: "channel" };
  await expect(pending).resolves.toEqual(failure);
  await expect(inbox.next()).resolves.toEqual(failure);
  inbox.failRequestBody();
  port2.close();
});

describe("SessionTransport", () => {
  it("asks every keeper of the session to re-attach at once when it has no transport", async () => {
    vi.useFakeTimers();
    const first = fakeKeeper("keeper-1");
    const second = fakeKeeper("keeper-2");
    const transport = new SessionTransport(SESSION, directory([first, second]));
    const acquiring = transport.acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.messages).toEqual([{ kind: "reattach", session: SESSION }]);
    expect(second.messages).toEqual([{ kind: "reattach", session: SESSION }]);
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    await expect(acquiring).resolves.toBe(port1);
    expect(transport.attached).toBe(true);
    port1.close();
  });

  it("shares one re-attach request among requests waiting together", async () => {
    vi.useFakeTimers();
    const keeper = fakeKeeper("keeper-1");
    const transport = new SessionTransport(SESSION, directory([keeper]));
    const first = transport.acquire();
    const second = transport.acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(keeper.messages).toHaveLength(1);
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    await expect(Promise.all([first, second])).resolves.toEqual([port1, port1]);
    port1.close();
  });

  it("answers null when no transport arrives within 10 s", async () => {
    vi.useFakeTimers();
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")]));
    let settled: MessagePort | null | undefined;
    void transport.acquire().then((port) => { settled = port; });
    await vi.advanceTimersByTimeAsync(ATTACH_WAIT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
  });

  it("drops a transport whose keeper closed and answers at once when no keeper is open", async () => {
    vi.useFakeTimers();
    const transport = new SessionTransport(SESSION, directory([], () => false));
    const { port1 } = new MessageChannel();
    const close = vi.spyOn(port1, "close");
    transport.attach(port1, "keeper-1");
    await expect(transport.acquire()).resolves.toBeNull();
    expect(close).toHaveBeenCalled();
    expect(transport.attached).toBe(false);
  });

  it("hands out the transport of a keeper that is still open without asking again", async () => {
    const keeper = fakeKeeper("keeper-1");
    const transport = new SessionTransport(SESSION, directory([keeper]));
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    await expect(transport.acquire()).resolves.toBe(port1);
    expect(keeper.messages).toEqual([]);
    port1.close();
  });

  it("closes the previous port when a keeper attaches again", () => {
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")]));
    const first = new MessageChannel().port1;
    const second = new MessageChannel().port1;
    const close = vi.spyOn(first, "close");
    transport.attach(first, "keeper-1");
    transport.attach(second, "keeper-1");
    expect(close).toHaveBeenCalled();
    second.close();
  });

  it("wakes waiting requests with null when the session drops its transport", async () => {
    vi.useFakeTimers();
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")]));
    const acquiring = transport.acquire();
    await vi.advanceTimersByTimeAsync(0);
    transport.drop();
    await expect(acquiring).resolves.toBeNull();
  });

  it("keeps waiting for a response while the keeper lives and gives up once it closes", async () => {
    vi.useFakeTimers();
    let open = true;
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")], () => open));
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    let settled: unknown;
    void transport.whileAlive(new Promise<string>(() => undefined), HEAD_WAIT_MS).then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(3 * LIVENESS_INTERVAL_MS);
    expect(settled).toBeUndefined();
    open = false;
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(settled).toEqual({ kind: "lost" });
    expect(transport.attached).toBe(false);
  });

  it("stops waiting for a response head before the browser stops the worker", async () => {
    // Chromium stops a Service Worker whose fetch event has not settled within five minutes; a
    // request may first spend up to ATTACH_WAIT_MS getting a transport.
    expect(ATTACH_WAIT_MS + HEAD_WAIT_MS).toBeLessThanOrEqual(5 * 60_000 - 30_000);
    vi.useFakeTimers();
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")]));
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    let settled: unknown;
    void transport.whileAlive(new Promise<string>(() => undefined), HEAD_WAIT_MS).then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(HEAD_WAIT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: "late" });
    expect(transport.attached).toBe(true);
    port1.close();
  });

  it("passes a response through that arrives while the keeper lives", async () => {
    const transport = new SessionTransport(SESSION, directory([fakeKeeper("keeper-1")]));
    const { port1 } = new MessageChannel();
    transport.attach(port1, "keeper-1");
    await expect(transport.whileAlive(Promise.resolve("head"), HEAD_WAIT_MS)).resolves.toEqual({ kind: "settled", value: "head" });
    port1.close();
  });
});
