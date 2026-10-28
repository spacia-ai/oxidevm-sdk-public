import { expect, it, vi } from "vitest";
import { ASSISTANCE_ARTIFACTS } from "../../assistance-build.js";
import { decodeBrokerAttention } from "../../protocol/assistance-broker.ts";
import type { AssistanceCredit } from "../../protocol/assistance-credit.ts";
import { SystemAssistance } from "./assistance.ts";

vi.mock("../../assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 },
} }));

function agent() {
  return { creditAssistance: (_id: number, credit: AssistanceCredit) => Promise.resolve(credit), setInstallationEvents: vi.fn(),
    startInstallation: () => Promise.reject(new Error("unexpected")), installation: () => Promise.reject(new Error("unexpected")),
    supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(), assistance: vi.fn() };
}

it("asks an attached broker for attention notices first and counts every message it receives after them", async () => {
  if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
  const notices = new MessageChannel(), broker = new MessageChannel(), counted = { delivered: 0, closed: 0 };
  const owner = new SystemAssistance(agent(), { attention: { open: () => ({ port: notices.port1,
    delivered: () => { counted.delivered += 1; }, close: () => { counted.closed += 1; } }) } });
  const first = new Promise<unknown>(accept => { broker.port2.onmessage = (event: MessageEvent<unknown>) => { accept(event.data); }; broker.port2.start(); });
  try {
    owner.attach({ ...owner.prepare(), port: broker.port1, artifacts: ASSISTANCE_ARTIFACTS });
    const attention = decodeBrokerAttention(await first);
    expect(attention.binding).toEqual({ session: owner.prepare().session, generation: owner.prepare().generation });
    // Every broker message is delivered once, whatever it holds.
    broker.port2.postMessage({ kind: "unknown-broker-message" });
    await vi.waitFor(() => expect(counted.delivered).toBe(1));
  } finally { await owner.dispose().catch(() => undefined); broker.port2.close(); notices.port2.close(); }
  expect(counted.closed).toBe(1);
});

it("attaches a broker without attention when none is available", async () => {
  if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
  const broker = new MessageChannel(), received: unknown[] = [];
  const owner = new SystemAssistance(agent(), { attention: { open: () => undefined } });
  broker.port2.onmessage = (event: MessageEvent<unknown>) => { received.push(event.data); }; broker.port2.start();
  try {
    owner.attach({ ...owner.prepare(), port: broker.port1, artifacts: ASSISTANCE_ARTIFACTS });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(received).toEqual([]);
  } finally { await owner.dispose().catch(() => undefined); broker.port2.close(); }
});
