import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets, type NodeSocket } from "./node-socket.js";
import { createHttpAgents } from "./node-http-agent.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

function fixture() {
  const context = createAsyncContext(); const controls: AssistanceOperation[] = []; let id = 0;
  const readers = new Map<number, PromiseWithResolvers<AssistanceResult>>();
  const net = createNodeSockets({ retain: () => () => {},
    callSync(operation) { controls.push(operation); return { kind: "unit" }; },
    call(operation) {
      if (operation.kind === "socket-connect-local") return Promise.resolve({ kind: "socket", fd: ++id, local: { address: "127.0.0.1", port: 1000 + id }, peer: operation.address });
      if (operation.kind === "socket-read") {
        const read = Promise.withResolvers<AssistanceResult>(); readers.set(operation.fd, read); return read.promise;
      }
      if (operation.kind === "socket-close") readers.get(operation.fd)?.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context);
  const { Agent } = createHttpAgents(net, context);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  function request(port = 3000) {
    const assigned = Promise.withResolvers<NodeSocket>();
    const request = { destroyed: false, reusedSocket: false, onSocket(socket?: NodeSocket, error?: Error) {
      if (error !== undefined) assigned.reject(error);
      else if (socket !== undefined) assigned.resolve(socket);
      else assigned.reject(new Error("Socket missing"));
    } };
    agent.addRequest(request, { host: "127.0.0.1", port });
    return { request, assigned: assigned.promise };
  }
  return { agent, request, controls, count: () => id };
}

it("queues at maxSockets and reuses the released connection without another native connect", async () => {
  const f = fixture(); const first = f.request(); const socket = await first.assigned;
  if (socket.connecting) await new Promise(resolve => socket.once("connect", resolve));
  const second = f.request(); let assigned = false; void second.assigned.then(() => { assigned = true; });
  await Promise.resolve(); expect(assigned).toBe(false);
  socket.emit("free");
  expect(await second.assigned).toBe(socket); expect(second.request.reusedSocket).toBe(false); expect(f.count()).toBe(1);
  socket.emit("free");
  expect(f.controls).toContainEqual({ kind: "socket-keepalive", fd: 1, enabled: true, delaySeconds: 1 });
  expect(f.agent.freeSockets[f.agent.getName({ host: "127.0.0.1", port: 3000 })]).toEqual([socket]);
  const third = f.request();
  expect(await third.assigned).toBe(socket); expect(third.request.reusedSocket).toBe(true);
  f.agent.destroy();
});

it("separates origins and transfers capacity after close while retiring cancelled requests", async () => {
  const f = fixture(); f.agent.maxTotalSockets = 1;
  const first = await f.request().assigned;
  const second = f.request(3001);
  first.destroy(); const replacement = await second.assigned;
  expect(replacement).not.toBe(first); expect(f.count()).toBe(2);
  const cancelled = f.request(3001); cancelled.request.destroyed = true;
  const failure = cancelled.assigned.catch((error: unknown) => error);
  replacement.emit("free");
  expect(await failure).toMatchObject({ code: "ECONNRESET" });
  f.agent.destroy();
});
