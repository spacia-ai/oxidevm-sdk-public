import { afterEach, expect, it, vi } from "vitest";
import { AgentPayloadWriter } from "../../agent-protocol.js";
import { scriptedGuest } from "./guest-agent.test-support.js";

const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); });

it("refuses native operations before sending them to an older image", async () => {
  const guest = scriptedGuest({ version: 7, capabilities: 3 });
  await guest.agent.wait(1, 1000);
  await expect(guest.agent.files.execute(2, { operation: "entries", path: "/" })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
  expect(guest.received.some(frame => frame.kind >= 26 && frame.kind <= 32)).toBe(false);
});

it("drains changes, drops replaced watch events and rescans after an agent restart", async () => {
  const guest = scriptedGuest({ version: 7, capabilities: 131 });
  await guest.agent.wait(1, 1000);
  guest.session.active = true;
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  const changes: unknown[] = [];
  channel.port2.onmessage = (event: MessageEvent<unknown>) => changes.push(event.data);
  guest.agent.files.watch(channel.port1);
  const settle = async () => { for (let i = 0; i < 8; i++) { guest.drain(); await new Promise(resolve => setTimeout(resolve, 0)); } };
  const first = guest.agent.files.setDirectories(["/"]); await settle(); await first;
  const id = guest.received.at(-1)?.requestId ?? 0;
  const payload = new AgentPayloadWriter().u32(0).u32(1).u32(0).string("file").finish();
  guest.send({ version: 7, kind: 0x107, requestId: id, status: 0, payload });
  guest.drain();
  await vi.waitFor(() => expect(changes).toEqual([{ type: "changes", changes: [{ kind: "changed", directory: "/", name: "file" }] }]));
  const next = guest.agent.files.setDirectories(["/app"]); await settle(); await next;
  guest.send({ version: 7, kind: 0x107, requestId: id, status: 0, payload }); guest.drain();
  expect(guest.agent.droppedFrames).toBe(1);
  guest.send({ version: 7, kind: 0x103, requestId: 0, status: 0, payload: new Uint8Array() });
  await settle();
  await vi.waitFor(() => expect(changes.at(-1)).toEqual({ type: "changes", changes: [{ kind: "rescan" }] }));
  expect(guest.received.filter(frame => frame.kind === 32)).toHaveLength(3);
  guest.agent.files.unwatch(); await settle();
  expect(guest.agent.files.draining).toBe(false);
});
