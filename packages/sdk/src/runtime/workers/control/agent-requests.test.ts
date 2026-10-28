import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RESPONSE_BIT, AgentKind, type AgentFrame } from "../../agent-protocol.js";
import { AgentRequests } from "./agent-requests.js";

function reply(id: number, kind: number = AgentKind.hello): AgentFrame {
  return { version: 4, requestId: id, kind: kind | AGENT_RESPONSE_BIT, status: 0, payload: new Uint8Array() };
}

describe("guest request completion under the existing execution pump", () => {
  afterEach(() => vi.useRealTimers());

  it("counts the replies that completed a waiting request, so a run slice can end to deliver them", () => {
    const requests = new AgentRequests();
    const first = requests.open(AgentKind.hello), second = requests.open(AgentKind.hello), abandoned = requests.open(AgentKind.hello);
    requests.abandon(abandoned);
    expect(requests.completed).toBe(0);
    requests.receive(reply(first.id));
    // A reply to an abandoned request completes no waiter.
    requests.receive(reply(abandoned.id));
    expect(requests.completed).toBe(1);
    requests.receive(reply(second.id));
    expect(requests.completed).toBe(2);
  });

  it("keeps legacy and guest-path spawn replies distinct in dialect seven", async () => {
    const requests = new AgentRequests();
    const legacy = requests.open(AgentKind.spawn);
    const guest = requests.open(AgentKind.guestSpawn);
    const result = requests.wait(guest, 1000);
    expect(() => requests.receive({ ...reply(guest.id, AgentKind.spawn), version: 7 })).toThrow("wrong response kind");
    requests.receive({ ...reply(guest.id, AgentKind.guestSpawn), version: 7 });
    await expect(result).resolves.toMatchObject({ kind: AgentKind.guestSpawn | AGENT_RESPONSE_BIT, version: 7 });
    expect(legacy.settled).toBe(false);
    requests.abandon(legacy);
  });

  it("keeps untimed I/O pending until cancellation without imposing an application deadline", async () => {
    vi.useFakeTimers();
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.assistance, 42);
    const result = requests.wait(ticket, null);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ticket.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    requests.cancelWorker(42);
    await rejected;
    requests.receive(reply(ticket.id, AgentKind.assistance));
    expect(requests.size).toBe(0);
  });

  it("completes concurrent passive requests in reply order without driving execution", async () => {
    const requests = new AgentRequests();
    const first = requests.open(AgentKind.hello);
    const second = requests.open(AgentKind.readFile);
    const a = requests.wait(first, 1000);
    const b = requests.wait(second, 1000);
    requests.receive(reply(second.id, AgentKind.readFile));
    requests.receive(reply(first.id));
    await expect(b).resolves.toEqual(reply(second.id, AgentKind.readFile));
    await expect(a).resolves.toEqual(reply(first.id));
    expect(requests.size).toBe(0);
  });

  it("aborts a blocked request, consumes its late reply once, and rejects duplicates", async () => {
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    const controller = new AbortController();
    const result = requests.wait(ticket, 1000, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await rejected;
    requests.receive(reply(ticket.id));
    expect(() => requests.receive(reply(ticket.id))).toThrow("unknown response");
    expect(requests.size).toBe(0);
  });

  it("bounds requests including abandoned requests whose replies have not arrived", () => {
    const requests = new AgentRequests();
    for (let index = 0; index < 1024; index += 1) {
      const ticket = requests.open(AgentKind.hello);
      requests.abandon(ticket);
    }
    expect(() => requests.open(AgentKind.hello)).toThrow("request limit");
    requests.receive(reply(1));
    expect(requests.open(AgentKind.hello).id).toBe(1025);
  });

  it("reset wakes blocked calls and does not reuse identities", async () => {
    const requests = new AgentRequests();
    const old = requests.open(AgentKind.hello);
    const result = requests.wait(old, 1000);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    requests.reset();
    const next = requests.open(AgentKind.hello);
    await rejected;
    expect(next.id).toBeGreaterThan(old.id);
    expect(() => requests.receive(reply(old.id))).toThrow("unknown response");
    expect(requests.size).toBe(1);
  });

  it("enforces deadlines without pumping and removes the timer after completion", async () => {
    vi.useFakeTimers();
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    const result = requests.wait(ticket, 1000);
    const rejected = expect(result).rejects.toMatchObject({ code: "GUEST_CRASH" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    requests.receive(reply(ticket.id));
  });

  it("rejects wrong and duplicate replies before exposing them to consumers", () => {
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    expect(() => requests.receive(reply(ticket.id, AgentKind.readFile))).toThrow("wrong response kind");
    expect(ticket.response()).toBeUndefined();
    requests.receive(reply(ticket.id));
    expect(() => requests.receive(reply(ticket.id))).toThrow("duplicate response");
    requests.finish(ticket);
  });

  it("keeps a received response when cancellation arrives afterward", async () => {
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    const controller = new AbortController();
    const result = requests.wait(ticket, 1000, controller.signal);
    requests.receive(reply(ticket.id));
    controller.abort();
    await expect(result).resolves.toEqual(reply(ticket.id));
  });

  it("cancels only requests belonging to the cancelled control operation", async () => {
    const requests = new AgentRequests();
    const a = requests.open(AgentKind.hello, 7);
    const b = requests.open(AgentKind.hello, 8);
    const cancelled = expect(requests.wait(a, 1000)).rejects.toMatchObject({ code: "ABORTED" });
    const live = requests.wait(b, 1000);
    requests.cancelWorker(7);
    requests.receive(reply(b.id));
    await cancelled;
    await expect(live).resolves.toEqual(reply(b.id));
  });

  it("fences received but unconsumed replies when a VM is replaced", async () => {
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    const result = requests.wait(ticket, 1000);
    requests.receive(reply(ticket.id));
    requests.reset();
    await expect(result).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("validates the operation identity even for an abandoned reply", () => {
    const requests = new AgentRequests();
    const ticket = requests.open(AgentKind.hello);
    requests.abandon(ticket);
    expect(() => requests.receive(reply(ticket.id, AgentKind.readFile))).toThrow("wrong response kind");
    requests.receive(reply(ticket.id));
    expect(() => requests.receive(reply(ticket.id))).toThrow("unknown response");
  });

  it("drops and counts replies below a resumed session's floor and continues its ids", () => {
    const requests = new AgentRequests();

    requests.resume(41);

    expect(() => requests.receive(reply(17))).not.toThrow();
    expect(() => requests.receive(reply(40))).not.toThrow();
    expect(requests.dropped).toBe(2);
    expect(() => requests.receive(reply(41))).toThrow("unknown response");
    expect(requests.open(AgentKind.hello).id).toBe(41);
    expect(requests.nextId).toBe(42);
  });
});
