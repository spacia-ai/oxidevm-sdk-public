import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { fakeLocks, launch, records, type Running } from "./harness.test-support.js";

afterEach(() => { vi.useRealTimers(); });

const ECHO = `export default host => {
  const echo = async connection => {
    for (;;) {
      const bytes = await connection.read(64);
      if (bytes.length === 0) return;
      await connection.write(bytes);
    }
  };
  return { info: () => ({ version: "1.2.3", ready: true }), protocols: { sql: echo, pg: echo } };
};`;

const serviceRelease = (adapter: string, declaration: Parameters<typeof buildRelease>[0]["declaration"] = SERVICE_DECLARATION, workspaceId: string | null = "ws-1"): Promise<Release> =>
  buildRelease({ adapter, declaration, ...(workspaceId === null ? {} : { workspaceId }) });

async function untilReady(running: Running): Promise<void> {
  await vi.waitFor(() => { expect(records(running.linux.stdoutLines).some(entry => entry["oxidevm"] === "ready")).toBe(true); });
}
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("service modules", () => {
  it("replaces a stale socket, listens on every endpoint, announces readiness and serves each protocol", async () => {
    const release = await serviceRelease(ECHO);
    const running = launch({ release, staleSockets: ["/workspace/_oxidevm/db.sock"] });
    await untilReady(running);
    expect(running.linux.unlinked).toEqual(["/workspace/_oxidevm/db.sock"]);
    expect([...running.linux.listening()].sort()).toEqual(["tcp:5432", "unix:/workspace/_oxidevm/db.sock"]);
    expect(records(running.linux.stdoutLines)).toEqual([{ oxidevm: "ready", v: 1, pid: 42, info: { version: "1.2.3", ready: true } }]);

    const sql = running.linux.connect("unix:/workspace/_oxidevm/db.sock"), pg = running.linux.connect("tcp:5432");
    sql.write(new TextEncoder().encode("hello")); pg.write(new TextEncoder().encode("world"));
    expect(decode(await sql.read(64))).toBe("hello");
    expect(decode(await pg.read(64))).toBe("world");
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
  });

  it("asks for EPIPE instead of SIGPIPE on every write to a client, so a client that hangs up cannot end the module", async () => {
    const release = await serviceRelease(ECHO);
    const running = launch({ release });
    await untilReady(running);
    const sql = running.linux.connect("unix:/workspace/_oxidevm/db.sock"), pg = running.linux.connect("tcp:5432");
    sql.write(new TextEncoder().encode("one")); pg.write(new TextEncoder().encode("two"));
    expect(decode(await sql.read(64))).toBe("one");
    expect(decode(await pg.read(64))).toBe("two");
    expect(running.linux.socketWrites).toEqual([{ noSignal: true }, { noSignal: true }]);
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
  });

  it("stops on end of input: unlinks its socket, closes listeners and connections, and calls close once", async () => {
    const release = await serviceRelease(`export default host => ({
      protocols: { sql: async connection => { await connection.read(1); }, pg: async () => {} },
      close: () => { host.log("closed"); },
    });`);
    const running = launch({ release });
    await untilReady(running);
    const client = running.linux.connect("unix:/workspace/_oxidevm/db.sock");
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.unlinked).toContain("/workspace/_oxidevm/db.sock");
    expect(running.linux.stderrLines.filter(line => line === "closed")).toHaveLength(1);
    expect(running.linux.listening()).toEqual([]);
    expect(running.linux.open.size).toBe(0);
    expect((await client.read(1)).length).toBe(0);
  });

  it("ignores data on standard input and stops only at end of file", async () => {
    const release = await serviceRelease(ECHO);
    const running = launch({ release });
    await untilReady(running);
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
  });

  it("serves at most limits.clients connections at once and closes the surplus immediately", async () => {
    const release = await serviceRelease(ECHO, { ...SERVICE_DECLARATION, limits: { clients: 2 } });
    const running = launch({ release });
    await untilReady(running);
    const clients = [1, 2, 3].map(() => running.linux.connect("tcp:5432"));
    const third = clients[2];
    if (third === undefined) throw new Error("missing client");
    await expect(third.read(1)).resolves.toHaveLength(0);
    for (const [index, client] of clients.slice(0, 2).entries()) { client.write(Uint8Array.of(65 + index)); expect(decode(await client.read(1))).toBe(String.fromCharCode(65 + index)); }
    const closedBefore = running.linux.closed.length;
    clients[0]?.close();
    // The slot is free once the server has closed its end of the first connection.
    await vi.waitFor(() => { expect(running.linux.closed.length).toBeGreaterThan(closedBefore); });
    const again = running.linux.connect("tcp:5432");
    again.write(Uint8Array.of(90));
    expect(decode(await again.read(1))).toBe("Z");
    running.linux.endStdin();
    await running.done;
  });

  it("logs a failing handler, closes only that connection and keeps serving", async () => {
    const release = await serviceRelease(`export default () => ({ protocols: {
      sql: async connection => { const bytes = await connection.read(1); if (bytes[0] === 33) throw new Error("bad request"); await connection.write(bytes); },
      pg: async () => {},
    } });`);
    const running = launch({ release });
    await untilReady(running);
    const bad = running.linux.connect("unix:/workspace/_oxidevm/db.sock");
    bad.write(Uint8Array.of(33));
    await expect(bad.read(1)).resolves.toHaveLength(0);
    expect(running.linux.stderrLines).toContain("connection handler failed: bad request");
    const good = running.linux.connect("unix:/workspace/_oxidevm/db.sock");
    good.write(Uint8Array.of(7));
    expect([...(await good.read(1))]).toEqual([7]);
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
  });

  it("closes idle connections at once, lets working ones finish for five seconds, then cancels them, and bounds a hanging close at ten seconds", async () => {
    vi.useFakeTimers();
    const release = await serviceRelease(`export default host => ({
      protocols: {
        sql: async connection => {
          const request = await connection.read(1);
          if (request[0] === 66) {
            // Busy: not waiting for the peer, and only a forced cancellation ends it.
            await new Promise(resolve => connection.signal.addEventListener("abort", resolve, { once: true }));
            host.log("handler cancelled");
            return;
          }
          try { await connection.read(1); } catch { host.log("idle handler ended"); }
        },
        pg: async () => {},
      },
      close: () => new Promise(() => {}),
    });`);
    const running = launch({ release });
    await vi.advanceTimersByTimeAsync(10);
    await untilReadyFake(running);
    const busy = running.linux.connect("unix:/workspace/_oxidevm/db.sock"), idle = running.linux.connect("unix:/workspace/_oxidevm/db.sock");
    busy.write(Uint8Array.of(66)); idle.write(Uint8Array.of(73));
    await vi.advanceTimersByTimeAsync(10);
    running.linux.endStdin();
    await vi.advanceTimersByTimeAsync(10);
    expect(running.linux.stderrLines).toContain("idle handler ended");
    await vi.advanceTimersByTimeAsync(4900);
    expect(running.linux.stderrLines).not.toContain("handler cancelled");
    await vi.advanceTimersByTimeAsync(200);
    expect(running.linux.stderrLines).toContain("handler cancelled");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.stderrLines.some(line => line.includes("adapter.close failed"))).toBe(true);
  });
});

/**
 * Importing the adapter is real asynchronous work that fake timers do not drive, so a fixed number of clock steps
 * can end before it finishes on a loaded machine. `vi.waitFor` polls in real time and advances the fake clock itself.
 */
async function untilReadyFake(running: Running): Promise<void> {
  await vi.waitFor(() => { expect(records(running.linux.stdoutLines).some(entry => entry["oxidevm"] === "ready")).toBe(true); }, { timeout: 10_000, interval: 10 });
}

describe("service start failures", () => {
  it("reports busy (124) without binding anything when another process holds the workspace lock", async () => {
    const release = await serviceRelease(ECHO);
    const { locks } = fakeLocks(new Set(["oxidevm-module:ws-1:db"]));
    const running = launch({ release, locks });
    await expect(running.done).resolves.toBe(124);
    expect(running.linux.listening()).toEqual([]);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "busy" });
    expect(running.imports.count).toBe(0);
  });

  it("allows the same module in another workspace and releases the lock when it stops", async () => {
    const held = new Set<string>(), { locks } = fakeLocks(held);
    const first = launch({ release: await serviceRelease(ECHO), locks });
    await untilReady(first);
    expect([...held]).toEqual(["oxidevm-module:ws-1:db"]);
    first.linux.endStdin();
    await first.done;
    expect(held.size).toBe(0);
  });

  it("reports busy (124) when an endpoint is already bound", async () => {
    const release = await serviceRelease(ECHO, { ...SERVICE_DECLARATION, process: { kind: "service" } }, null);
    const running = launch({ release, occupied: ["tcp:5432"] });
    await expect(running.done).resolves.toBe(124);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "busy", message: "Endpoint pg is already in use" });
    // The endpoint that was bound first is released again.
    expect(running.linux.listening()).toEqual([]);
  });

  it("reports prerequisite (122) for an exclusive service when Web Locks are unavailable", async () => {
    const running = launch({ release: await serviceRelease(ECHO), locks: null });
    await expect(running.done).resolves.toBe(122);
  });

  it("reports launch (120) when an exclusive service has no workspace id", async () => {
    const running = launch({ release: await serviceRelease(ECHO, SERVICE_DECLARATION, null) });
    await expect(running.done).resolves.toBe(120);
  });

  it("reports adapter (123) for handlers that do not match the declared endpoints", async () => {
    const bad: readonly (readonly [string, string])[] = [
      ["missing handler", "export default () => ({ protocols: { sql: async () => {} } });"],
      ["undeclared handler", "export default () => ({ protocols: { sql: async () => {}, pg: async () => {}, extra: async () => {} } });"],
      ["no protocols", "export default () => ({});"],
      ["handler is not a function", "export default () => ({ protocols: { sql: 1, pg: async () => {} } });"],
      ["info returns an object with nested values", "export default () => ({ info: () => ({ nested: {} }), protocols: { sql: async () => {}, pg: async () => {} } });"],
      ["a command-style adapter", "export default () => ({ main: () => 0 });"],
    ];
    for (const [name, adapter] of bad) {
      const running = launch({ release: await serviceRelease(adapter) });
      await expect(running.done, name).resolves.toBe(123);
      expect(running.linux.listening(), name).toEqual([]);
    }
  });
});

describe("socket files", () => {
  const SOCKET = "/workspace/_oxidevm/db.sock";

  it("refuses a regular file at a declared socket path instead of deleting it", async () => {
    const running = launch({ release: await serviceRelease(ECHO), paths: { [SOCKET]: 0o100644 } });
    await expect(running.done).resolves.toBe(120);
    expect(running.linux.unlinked).toEqual([]);
    expect(running.linux.listening()).toEqual([]);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "launch" });
    expect(JSON.stringify(records(running.linux.stderrLines))).toContain("not a socket");
  });

  it("reports busy and leaves the file alone when a live process still listens on it", async () => {
    const running = launch({ release: await serviceRelease(ECHO), staleSockets: [SOCKET], occupied: [`unix:${SOCKET}`] });
    await expect(running.done).resolves.toBe(124);
    expect(running.linux.unlinked).toEqual([]);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "busy" });
  });

  it("removes its own socket on stop, but not a socket another process put in its place meanwhile", async () => {
    const running = launch({ release: await serviceRelease(ECHO) });
    await untilReady(running);
    running.linux.replaceSocketFile(SOCKET);
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.unlinked).not.toContain(SOCKET);
  });

  it("removes its own socket on stop when nothing replaced it", async () => {
    const running = launch({ release: await serviceRelease(ECHO) });
    await untilReady(running);
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.unlinked).toEqual([SOCKET]);
  });
});

describe("accept errors", () => {
  const ECONNABORTED = 103, EINTR = 4, EMFILE = 24, EBADF = 9;

  it("keeps serving after an accept fails for a reason that concerns one connection or a moment", async () => {
    const running = launch({ release: await serviceRelease(ECHO), acceptFailures: [ECONNABORTED, EINTR, EMFILE] });
    await untilReady(running);
    const client = running.linux.connect("tcp:5432");
    client.write(new TextEncoder().encode("still here"));
    expect(decode(await client.read(64))).toBe("still here");
    expect(running.linux.stderrLines.join("\n")).toContain("accept failed");
    running.linux.endStdin();
    await expect(running.done).resolves.toBe(0);
  });

  it("still ends the service when the listener itself is broken", async () => {
    const running = launch({ release: await serviceRelease(ECHO), acceptFailures: [EBADF] });
    await expect(running.done).resolves.not.toBe(0);
  });
});

