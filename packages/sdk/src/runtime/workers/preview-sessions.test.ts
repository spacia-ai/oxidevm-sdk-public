import { expect, it, vi } from "vitest";
import { PreviewSessions } from "./preview-sessions.js";
import type { PreviewRuntimePort } from "./preview-http.js";

const runtime: PreviewRuntimePort = { request: () => Promise.resolve({ kind: "error", code: "listener" }) };

it("bounds transports per session, retiring the oldest, and closes a whole session at once", () => {
  const sessions = new PreviewSessions();
  const ports: MessagePort[] = [];
  const closed = vi.fn();
  for (let index = 0; index < 9; index += 1) {
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    channel.port1.addEventListener("close", closed);
    sessions.expose("a".repeat(32), 3000, channel.port1, runtime, new URL(`https://${"a".repeat(32)}.oxidevm-preview.test:4573`));
  }
  expect(sessions.size).toBe(1);
  sessions.expose("b".repeat(32), 3001, new MessageChannel().port1, runtime, new URL(`https://${"b".repeat(32)}.oxidevm-preview.test:4573`));
  expect(sessions.size).toBe(2);
  sessions.close("a".repeat(32));
  expect(sessions.size).toBe(1);
  sessions.closeAll();
  expect(sessions.size).toBe(0);
  for (const port of ports) port.close();
});
