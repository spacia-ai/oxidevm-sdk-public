import { describe, expect, it } from "vitest";

import { decodeKeeperBootstrap, Keeper, registrationFailure, type KeeperEnvironment } from "./keeper";

const SESSION = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const LOCATION = { origin: `http://${SESSION}.localhost:5174`, hostname: `${SESSION}.localhost` };
const BOOTSTRAP = { session: SESSION, parentOrigin: "http://localhost:5173", isolation: "per-session" } as const;

interface Pong { readonly attached: boolean; readonly retired: boolean }

/** A worker that acknowledges every attach and answers pings from a script. */
function fakeEnvironment(pongs: Pong[] = [], answer = "attached"): KeeperEnvironment & { readonly received: unknown[]; requested: number } {
  const received: unknown[] = [];
  const environment = {
    received,
    requested: 0,
    owner: { postMessage: () => undefined },
    worker: () => ({
      postMessage(message: unknown) {
        received.push(message);
        if (typeof message !== "object" || message === null || !("kind" in message) || !("acknowledgement" in message)) return;
        const acknowledgement = message.acknowledgement;
        if (!(acknowledgement instanceof MessagePort)) return;
        if (message.kind === "attach") acknowledgement.postMessage({ kind: answer, session: SESSION });
        if (message.kind === "ping") acknowledgement.postMessage({ kind: "pong", session: SESSION, ...(pongs.shift() ?? { attached: true, retired: true }) });
      },
    }),
    requestPort: () => {
      environment.requested += 1;
      return Promise.resolve(new MessageChannel().port1);
    },
    sleep: () => Promise.resolve(),
  };
  return environment;
}

function kinds(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => typeof message === "object" && message !== null && "kind" in message ? message.kind : message);
}

describe("Keeper", () => {
  it("attaches the transport with the parent origin it was given", async () => {
    const environment = fakeEnvironment();
    await new Keeper(BOOTSTRAP, environment).attach();
    expect(environment.received).toEqual([expect.objectContaining({ kind: "attach", session: SESSION, parentOrigin: "http://localhost:5173" })]);
  });

  it.each([
    ["retired", "preview session retired"],
    ["refused", "preview session refused by this address"],
  ])("fails an attach the worker answers %s", async (answer, message) => {
    await expect(new Keeper(BOOTSTRAP, fakeEnvironment([], answer)).attach()).rejects.toThrow(message);
  });

  it("re-attaches once when the worker asks repeatedly", async () => {
    const environment = fakeEnvironment();
    const keeper = new Keeper(BOOTSTRAP, environment);
    keeper.onWorkerMessage({ kind: "reattach", session: SESSION });
    keeper.onWorkerMessage({ kind: "reattach", session: SESSION });
    await keeper.attach();
    expect(environment.requested).toBe(1);
    expect(kinds(environment.received)).toEqual(["attach"]);
  });

  it.each([
    ["another session", { kind: "reattach", session: OTHER }],
    ["an extra field", { kind: "reattach", session: SESSION, port: 1 }],
    ["no record", "reattach"],
  ])("ignores a re-attach request with %s", (_name, message) => {
    const environment = fakeEnvironment();
    new Keeper(BOOTSTRAP, environment).onWorkerMessage(message);
    expect(environment.requested).toBe(0);
  });

  it("tells the worker when the session retires and stops re-attaching", () => {
    const environment = fakeEnvironment();
    const keeper = new Keeper(BOOTSTRAP, environment);
    keeper.retire();
    keeper.onWorkerMessage({ kind: "reattach", session: SESSION });
    expect(environment.received).toEqual([{ kind: "retire", session: SESSION }]);
    expect(environment.requested).toBe(0);
  });

  it("grants a fresh transport when a ping finds the worker without one", async () => {
    const environment = fakeEnvironment([{ attached: false, retired: false }, { attached: true, retired: true }]);
    await new Keeper(BOOTSTRAP, environment).run();
    expect(environment.requested).toBe(1);
    expect(kinds(environment.received)).toEqual(["ping", "attach", "ping"]);
  });
});

describe("decodeKeeperBootstrap", () => {
  const search = (session: string, parent: string | null): string =>
    `?session=${session}${parent === null ? "" : `&parentOrigin=${encodeURIComponent(parent)}`}`;

  it("accepts a session on its own origin and a Playground parent", () => {
    expect(decodeKeeperBootstrap(search(SESSION, "http://localhost:5173"), LOCATION)).toEqual(BOOTSTRAP);
    expect(decodeKeeperBootstrap(search(SESSION, "https://play.example"), LOCATION)).toEqual({ session: SESSION, parentOrigin: "https://play.example", isolation: "per-session" });
  });

  it("accepts the shared address only from a Playground on the same host", () => {
    const shared = { origin: "https://fedora.tail133191.ts.net:8443", hostname: "fedora.tail133191.ts.net" };
    expect(decodeKeeperBootstrap(`${search(SESSION, "https://fedora.tail133191.ts.net")}&isolation=shared`, shared))
      .toEqual({ session: SESSION, parentOrigin: "https://fedora.tail133191.ts.net", isolation: "shared" });
    expect(() => decodeKeeperBootstrap(`${search(SESSION, "https://evil.example")}&isolation=shared`, shared))
      .toThrow("unsafe preview parent origin");
  });

  it.each([["private"], ["per-session"], [""]])("refuses the isolation %j", (isolation) => {
    expect(() => decodeKeeperBootstrap(`${search(SESSION, "http://localhost:5173")}&isolation=${isolation}`, LOCATION)).toThrow("invalid preview bootstrap");
  });

  it.each([
    ["a malformed session", search("XYZ", "http://localhost:5173"), "invalid preview bootstrap"],
    ["no parent", search(SESSION, null), "invalid preview bootstrap"],
    ["another session's origin", search(OTHER, "http://localhost:5173"), "preview session does not match its origin"],
    ["a LAN http parent", search(SESSION, "http://10.0.0.2:5173"), "unsafe preview parent origin"],
    ["its own origin as parent", search(SESSION, LOCATION.origin), "unsafe preview parent origin"],
    ["a parent with a path", search(SESSION, "https://play.example/x"), "unsafe preview parent origin"],
    ["a parent that is not a URL", search(SESSION, "play"), "unsafe preview parent origin"],
  ])("refuses %s", (_name, value, message) => {
    expect(() => decodeKeeperBootstrap(value, LOCATION)).toThrow(message);
  });
});

describe("registrationFailure", () => {
  it("names a worker the browser refused as blocked", () => {
    expect(registrationFailure(new DOMException("The user denied permission to use Service Worker.", "NotSupportedError"))).toBe("service-worker-blocked");
  });

  it.each([
    ["a script that failed", new TypeError("Failed to register a ServiceWorker: A bad HTTP response code (404)")],
    ["a scope the server does not allow", new DOMException("The path of the provided scope is not under the max scope allowed", "SecurityError")],
    ["anything else", "failed"],
  ])("names %s as failed", (_name, error) => {
    expect(registrationFailure(error)).toBe("service-worker-failed");
  });
});
