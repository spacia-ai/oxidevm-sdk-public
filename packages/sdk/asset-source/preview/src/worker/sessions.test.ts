import { describe, expect, it, vi } from "vitest";

import { SessionRegistry, workerScope, type SessionStore } from "./sessions";
import { SessionTransport, type KeeperDirectory } from "./transport";

const A = "a".repeat(32);
const B = "b".repeat(32);
const PARENT = "https://fedora.tail133191.ts.net";
const OTHER_PARENT = "https://fedora.tail133191.ts.net:9443";

const directory: KeeperDirectory = { keepers: () => Promise.resolve([]), isOpen: () => Promise.resolve(true) };
const transports = (session: string): SessionTransport => new SessionTransport(session, directory);
const port = (): MessagePort => new MessageChannel().port1;

interface MemoryStore extends SessionStore {
  readonly written: unknown[];
  readonly marked: string[];
  reads: number;
}

function memoryStore(initial: { readonly current?: unknown; readonly read?: () => Promise<unknown> } = {}): MemoryStore {
  const retired = new Set<string>();
  const store: MemoryStore = {
    written: [],
    marked: [],
    reads: 0,
    readCurrent: () => {
      store.reads += 1;
      return initial.read?.() ?? Promise.resolve(initial.current ?? null);
    },
    writeCurrent: (current) => {
      store.written.push(current);
      return Promise.resolve();
    },
    isRetired: (key) => Promise.resolve(retired.has(key)),
    markRetired: (key) => {
      retired.add(key);
      store.marked.push(key);
      return Promise.resolve();
    },
  };
  return store;
}

describe("workerScope", () => {
  it("tells a session origin from the shared address", () => {
    expect(workerScope(`${A}.localhost`)).toEqual({ kind: "per-session", session: A });
    expect(workerScope(`${A}.preview.example`)).toEqual({ kind: "per-session", session: A });
    expect(workerScope("fedora.tail133191.ts.net")).toEqual({ kind: "shared" });
    expect(workerScope("localhost")).toEqual({ kind: "shared" });
  });
});

describe("SessionRegistry", () => {
  it("serves only its own session on a per-session origin", async () => {
    const registry = new SessionRegistry({ kind: "per-session", session: A }, transports, memoryStore());
    await expect(registry.attach(B, port(), "keeper-b", PARENT)).resolves.toBe("refused");
    await expect(registry.attach(A, port(), "keeper-a", PARENT)).resolves.toBe("attached");
    await expect(registry.route(null)).resolves.toMatchObject({ kind: "session", session: A });
  });

  it("replaces the active session on the shared address and retires the previous one for its keeper", async () => {
    const registry = new SessionRegistry({ kind: "shared" }, transports, memoryStore());
    await registry.attach(A, port(), "keeper-a", PARENT);
    await registry.attach(B, port(), "keeper-b", PARENT);
    expect(registry.current()?.session).toBe(B);
    await expect(registry.status(A)).resolves.toEqual({ attached: false, retired: true });
    await expect(registry.status(B)).resolves.toEqual({ attached: true, retired: false });
  });

  it("sends pages of a replaced session to the moved page", async () => {
    const registry = new SessionRegistry({ kind: "shared" }, transports, memoryStore());
    await registry.attach(A, port(), "keeper-a", PARENT);
    registry.bind("c1", A);
    await registry.attach(B, port(), "keeper-b", PARENT);
    await expect(registry.route("c1")).resolves.toEqual({ kind: "moved" });
    await expect(registry.route("c2")).resolves.toMatchObject({ kind: "session", session: B });
  });

  it("retires one shared session without retiring the address", async () => {
    const registry = new SessionRegistry({ kind: "shared" }, transports, memoryStore());
    await registry.attach(A, port(), "keeper-a", PARENT);
    await registry.retire(A);
    await expect(registry.status(A)).resolves.toEqual({ attached: false, retired: true });
    await expect(registry.attach(B, port(), "keeper-b", PARENT)).resolves.toBe("attached");
    await expect(registry.status(B)).resolves.toEqual({ attached: true, retired: false });
  });

  it("answers a retired per-session origin as retired and refuses its keeper", async () => {
    const store = memoryStore();
    const registry = new SessionRegistry({ kind: "per-session", session: A }, transports, store);
    await registry.attach(A, port(), "keeper-a", PARENT);
    await registry.retire(A);
    await expect(registry.route(null)).resolves.toEqual({ kind: "retired" });
    await expect(registry.attach(A, port(), "keeper-a", PARENT)).resolves.toBe("retired");
    expect(store.marked).toEqual(["retired"]);
  });

  it("keeps a replaced session retired after the worker restarts", async () => {
    const store = memoryStore();
    const before = new SessionRegistry({ kind: "shared" }, transports, store);
    await before.attach(A, port(), "keeper-a", PARENT);
    await before.attach(B, port(), "keeper-b", PARENT);
    expect(store.marked).toEqual([`retired/${A}`]);
    const after = new SessionRegistry({ kind: "shared" }, transports, store);
    await expect(after.attach(A, port(), "keeper-a", PARENT)).resolves.toBe("retired");
  });

  it("restores the current session and its parent after the worker restarts", async () => {
    const store = memoryStore({ current: { session: B, parentOrigin: PARENT } });
    const registry = new SessionRegistry({ kind: "shared" }, transports, store);
    await expect(registry.route("a-page-from-before-the-restart")).resolves.toMatchObject({ kind: "session", session: B });
    await expect(registry.parent()).resolves.toBe(PARENT);
    await expect(registry.parent()).resolves.toBe(PARENT);
    expect(store.reads).toBe(1);
  });

  it("persists the session and parent a keeper attached", async () => {
    const store = memoryStore();
    const registry = new SessionRegistry({ kind: "per-session", session: A }, transports, store);
    await registry.attach(A, port(), "keeper-a", PARENT);
    expect(store.written).toEqual([{ session: A, parentOrigin: PARENT }]);
    await expect(registry.parent()).resolves.toBe(PARENT);
  });

  it("never lets the stored parent replace one a keeper attached while it was being read", async () => {
    let finishRead: (value: unknown) => void = () => undefined;
    const store = memoryStore({ read: () => new Promise((resolve) => { finishRead = resolve; }) });
    const registry = new SessionRegistry({ kind: "per-session", session: A }, transports, store);
    const reading = registry.parent();
    const attaching = registry.attach(A, port(), "keeper-a", OTHER_PARENT);
    finishRead({ session: A, parentOrigin: PARENT });
    await expect(attaching).resolves.toBe("attached");
    await reading;
    await expect(registry.parent()).resolves.toBe(OTHER_PARENT);
    expect(store.reads).toBe(1);
  });

  it("retires the stored session when another attaches while it is still being read", async () => {
    let finishRead: (value: unknown) => void = () => undefined;
    const store = memoryStore({ read: () => new Promise((resolve) => { finishRead = resolve; }) });
    const registry = new SessionRegistry({ kind: "shared" }, transports, store);
    const attaching = registry.attach(B, port(), "keeper-b", PARENT);
    await vi.waitFor(() => { expect(store.reads).toBe(1); });
    finishRead({ session: A, parentOrigin: PARENT });
    await expect(attaching).resolves.toBe("attached");
    expect(registry.current()?.session).toBe(B);
    await expect(registry.status(A)).resolves.toEqual({ attached: false, retired: true });
  });

  it.each([
    ["a malformed session", { session: "x", parentOrigin: PARENT }],
    ["an unsafe parent", { session: B, parentOrigin: "http://10.0.0.2:5173" }],
    ["an extra field", { session: B, parentOrigin: PARENT, port: 1 }],
    ["no record", "current"],
  ])("ignores a stored session with %s", async (_name, current) => {
    const registry = new SessionRegistry({ kind: "shared" }, transports, memoryStore({ current }));
    await expect(registry.route(null)).resolves.toEqual({ kind: "none" });
    await expect(registry.parent()).resolves.toBeNull();
  });

  it("ignores a stored session of another origin on a per-session origin", async () => {
    const registry = new SessionRegistry({ kind: "per-session", session: A }, transports, memoryStore({ current: { session: B, parentOrigin: PARENT } }));
    await expect(registry.parent()).resolves.toBeNull();
  });
});

describe("SessionRegistry site access", () => {
  const SITES = { kind: "sites", sites: ["api.example.com"] } as const;
  const ANY = { kind: "any" } as const;
  const perSession = (store: SessionStore = memoryStore()): SessionRegistry => new SessionRegistry({ kind: "per-session", session: A }, transports, store);

  it("site access defaults to none", async () => {
    await expect(perSession().siteAccess()).resolves.toEqual({ kind: "none" });
    await expect(new SessionRegistry({ kind: "shared" }, transports, memoryStore()).siteAccess()).resolves.toEqual({ kind: "none" });
  });

  it("applied site access is what siteAccess() returns", async () => {
    const registry = perSession();
    await expect(registry.setSiteAccess(A, 1, SITES)).resolves.toBe("applied");
    await expect(registry.siteAccess()).resolves.toEqual(SITES);
  });

  it("a restarted worker starts with no sites", async () => {
    const store = memoryStore({ current: { session: A, parentOrigin: PARENT } });
    for (const scope of [{ kind: "per-session", session: A }, { kind: "shared" }] as const) {
      await expect(new SessionRegistry(scope, transports, store).setSiteAccess(A, 3, SITES)).resolves.toBe("applied");
      const restarted = new SessionRegistry(scope, transports, store);
      await expect(restarted.siteAccess()).resolves.toEqual({ kind: "none" });
      // The keeper restores the grant with its unchanged revision.
      await expect(restarted.setSiteAccess(A, 3, SITES)).resolves.toBe("applied");
      await expect(restarted.siteAccess()).resolves.toEqual(SITES);
    }
  });

  it("a lower or equal revision is stale", async () => {
    const registry = perSession();
    await registry.setSiteAccess(A, 5, SITES);
    await expect(registry.setSiteAccess(A, 5, ANY)).resolves.toBe("stale");
    await expect(registry.setSiteAccess(A, 4, ANY)).resolves.toBe("stale");
    await expect(registry.siteAccess()).resolves.toEqual(SITES);
    await expect(registry.setSiteAccess(A, 6, ANY)).resolves.toBe("applied");
  });

  it("a retired session refuses site access", async () => {
    const registry = perSession();
    await registry.retire(A);
    await expect(registry.setSiteAccess(A, 1, SITES)).resolves.toBe("retired");
    await expect(perSession().setSiteAccess(B, 1, SITES)).resolves.toBe("retired");
  });

  it("a new session on the shared address starts with no sites", async () => {
    const registry = new SessionRegistry({ kind: "shared" }, transports, memoryStore());
    await registry.attach(A, port(), "keeper-a", PARENT);
    await expect(registry.setSiteAccess(A, 1, SITES)).resolves.toBe("applied");
    await registry.attach(B, port(), "keeper-b", PARENT);
    await expect(registry.siteAccess()).resolves.toEqual({ kind: "none" });
    await expect(registry.setSiteAccess(A, 2, ANY)).resolves.toBe("retired");
    await expect(registry.setSiteAccess(B, 1, ANY)).resolves.toBe("applied");
  });
});
