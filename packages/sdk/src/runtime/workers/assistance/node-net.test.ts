import { ProcessScheduler } from "./process-scheduler.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeNet } from "./node-net.js";

const schedulers: ProcessScheduler[] = [];
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.dispose(); });
function schedulerFor(context: ReturnType<typeof createAsyncContext>, enabled: boolean): ProcessScheduler | undefined {
  if (!enabled) return undefined;
  const scheduler = new ProcessScheduler(context, error => { throw error; });
  schedulers.push(scheduler);
  return scheduler;
}

const listener = { kind: "socket", fd: 1, local: { address: "::", port: 3000 }, peer: null } as const;
const accepted = { kind: "socket", fd: 2, local: listener.local, peer: { address: "::1", port: 1234 } } as const;
const closedError = { kind: "error", errno: 9, code: "EBADF", syscall: "accept", path: null, destination: null } as const;

it.each([false, true])("closes the Linux listener and preserves close context (scheduler=%s)", async scheduled => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  let references = 0; let accepts = 0; const closed: number[] = [];
  const accept = Promise.withResolvers<AssistanceResult>(); const read = Promise.withResolvers<AssistanceResult>();
  const net = createNodeNet({ callSync: () => accepted,
    retain() { references++; return () => { references--; }; },
    call(operation) {
      if (operation.kind === "socket-listen") return Promise.resolve(listener);
      if (operation.kind === "socket-accept") return ++accepts === 1 ? Promise.resolve(accepted) : accept.promise;
      if (operation.kind === "socket-read") return read.promise;
      if (operation.kind === "socket-close") {
        closed.push(operation.fd);
        if (operation.fd === 1) accept.resolve(closedError);
        else read.resolve({ kind: "data", bytes: new Uint8Array() });
      }
      return Promise.resolve({ kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const connection = Promise.withResolvers<InstanceType<typeof net.Socket>>();
  const server = net.createServer((socket: unknown) => {
    if (!(socket instanceof net.Socket)) throw new TypeError("socket required");
    connection.resolve(socket);
  });
  const errors: unknown[] = []; server.on("error", error => errors.push(error));
  server.listen(3000);
  const socket = await connection.promise;
  expect(references).toBe(2);
  expect(server.address()).toEqual({ address: "::", port: 3000, family: "IPv6" });
  expect(await new Promise(resolve => server.getConnections((error: unknown, count: unknown) => resolve([error, count])))).toEqual([null, 1]);
  let finished = false;
  const completion = store.run("server-close", () => new Promise(resolve => server.close(() => {
    finished = true; resolve(store.getStore());
  })));
  await vi.waitFor(() => expect(closed).toEqual([1]));
  expect(finished).toBe(false);
  expect(server.listening).toBe(false);
  socket.destroy();
  expect(await completion).toBe("server-close");
  expect(closed).toEqual([1, 2]);
  expect(errors).toEqual([]);
  expect(references).toBe(0);
});

it.each([false, true])("retires a cancelled bind without listening or accept (scheduler=%s)", async scheduled => {
  const context = createAsyncContext();
  const binding = Promise.withResolvers<AssistanceResult>(); const operations: string[] = []; let references = 0;
  const net = createNodeNet({ callSync: () => accepted,
    retain() { references++; return () => { references--; }; },
    call(operation) {
      operations.push(operation.kind);
      return operation.kind === "socket-listen" ? binding.promise : Promise.resolve({ kind: "unit" });
    },
  }, context, schedulerFor(context, scheduled));
  const server = net.createServer(); const listening = vi.fn(); server.on("listening", listening);
  server.listen({ port: 3000 });
  const closed = new Promise(resolve => server.close(resolve));
  server.unref(); server.unref(); expect(references).toBe(0);
  binding.resolve(listener);
  await closed;
  expect(listening).not.toHaveBeenCalled();
  expect(operations).toEqual(["socket-listen", "socket-close"]);
  expect(references).toBe(0);
});
