import { expect, it } from "vitest";
import { AgentInput } from "./agent-input.ts";
import { AgentFrameDecoder, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.ts";
import { encodeInstallationRequest } from "../../protocol/assistance-installation.js";
import { encodeAssistanceRequest } from "../../protocol/assistance.ts";
import { encodeAssistanceCredit } from "../../protocol/assistance-credit.ts";
import { encodeAssistanceVmRequest } from "../../protocol/assistance-vm.ts";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: 1 };
it.each([5, 6, 7] as const)("v%i admits VM fencing in reserved capacity without a fabricated process", version => {
  const input = new AgentInput();
  for (let requestId = 1; requestId <= 127; requestId++) input.enqueue({ version, kind: 3, requestId, status: 0, payload: Uint8Array.of(65) });
  input.enqueue({ version, kind: 16, requestId: 128, status: 0,
    payload: encodeAssistanceVmRequest({ session: identity.session, generation: 1, sequence: 2, operation: "fence" }) });
  const frames: AgentFrame[] = [];
  const decoder = new AgentFrameDecoder();
  input.flush(bytes => { frames.push(...decoder.push(bytes)); return bytes.length; });
  expect(frames[0]?.kind).toBe(16);
  expect(frames).toHaveLength(128);
});
it.each([5, 6, 7] as const)("lets v%i cancellation and assistance finish before a blocked legacy bulk transfer", version => {
  const input = new AgentInput();
  const legacy: AgentFrame = { version, kind: 3, requestId: 1, status: 0, payload: new Uint8Array(16384) };
  input.enqueue(legacy);
  const wire: Uint8Array[] = [];
  let first = true;
  input.flush(bytes => { if (!first) return 0; first = false; wire.push(bytes.slice()); return bytes.length; });
  input.enqueue({ version, kind: 14, requestId: 2, status: 0,
    payload: encodeAssistanceRequest({ ...identity, operation: { kind: "write", fd: 1, offset: null, bytes: new Uint8Array(8192) } }) });
  input.enqueue({ version, kind: 14, requestId: 3, status: 0,
    payload: encodeAssistanceRequest({ ...identity, sequence: 2, operation: { kind: "stop" } }) });
  input.flush(bytes => { wire.push(bytes.slice()); return bytes.length; });
  const decoder = new AgentFrameDecoder();
  const frames = wire.flatMap(bytes => decoder.push(bytes));
  expect(frames.map(frame => frame.requestId)).toEqual([3, 2, 1]);
  expect(frames[2]).toEqual(legacy);
  expect(input.hasPending).toBe(false);
});

it.each([3, 4] as const)("retains exact ordinary v%i bytes and partial-write order", version => {
  const input = new AgentInput();
  const frame: AgentFrame = { version, kind: 3, requestId: 1, status: 0, payload: new Uint8Array(9000).fill(65) };
  input.enqueue(frame);
  const wire: number[] = [];
  input.flush(bytes => { wire.push(bytes[0] ?? 0); return 1; });
  expect(Uint8Array.from(wire)).toEqual(encodeAgentFrame(frame));
  expect(input.hasPending).toBe(false);
});

it.each([5, 6, 7] as const)("v%i reserves supervisory queue space and releases held frames on reset", version => {
  const input = new AgentInput();
  for (let requestId = 1; requestId <= 127; requestId++) {
    input.enqueue({ version, kind: 3, requestId, status: 0, payload: Uint8Array.of(65) });
  }
  expect(() => input.enqueue({ version, kind: 3, requestId: 128, status: 0, payload: Uint8Array.of(65) })).toThrow("protocol limit");
  input.enqueue({ version, kind: 14, requestId: 129, status: 0,
    payload: encodeAssistanceRequest({ ...identity, operation: { kind: "stop" } }) });
  let first = true;
  input.flush(bytes => {
    if (!first) return 0;
    first = false;
    expect(new AgentFrameDecoder().push(bytes)[0]?.requestId).toBe(129);
    return bytes.length;
  });
  expect(input.hasPending).toBe(true);
  input.clear();
  expect(input.hasPending).toBe(false);
  input.flush(() => { throw new Error("retired wire bytes reused"); });
  input.enqueue({ version, kind: 3, requestId: 130, status: 0, payload: Uint8Array.of(66) });
  expect(() => input.flush(() => -1)).toThrow("invalid byte count");
});

it.each([5, 6, 7] as const)("v%i credit grants use reserved capacity and reject malformed envelopes before enqueueing", version => {
  const input = new AgentInput();
  const payload = encodeAssistanceCredit({ session: identity.session, generation: 1, process: 1,
    sequence: 1, reservation: 1, producer: "guest", kind: "grant", pool: "data", bytes: 1024, entries: 1 });
  expect(() => input.enqueue({ version, kind: 17, requestId: 1, status: 0, payload: payload.slice(0, -1) })).toThrow();
  for (let requestId = 1; requestId <= 127; requestId++) input.enqueue({ version, kind: 3, requestId, status: 0, payload: Uint8Array.of(65) });
  input.enqueue({ version, kind: 17, requestId: 128, status: 0, payload });
  const frames: AgentFrame[] = []; const decoder = new AgentFrameDecoder();
  input.flush(bytes => { frames.push(...decoder.push(bytes)); return bytes.length; });
  expect(frames[0]?.kind).toBe(17); expect(frames).toHaveLength(128);
});


it.each(["stop", "retire", "acknowledge", "capture-retire"] as const)("installation %s uses supervisory capacity under saturation", kind => {
  for (const version of [6, 7] as const) {
    const input = new AgentInput();
    for (let requestId = 1; requestId <= 127; requestId++) input.enqueue({ version, kind: 3, requestId, status: 0, payload: Uint8Array.of(65) });
    input.enqueue({ version, kind: 19, requestId: 128, status: 0,
      payload: encodeInstallationRequest({ session: identity.session, generation: 1, installation: 1, sequence: 2, operation: { kind } }, version) });
    const frames: AgentFrame[] = []; const decoder = new AgentFrameDecoder();
    input.flush(bytes => { frames.push(...decoder.push(bytes)); return bytes.length; });
    expect(frames[0]?.requestId).toBe(128);
    expect(frames).toHaveLength(128);
  }
});

it("completes the frame the guest was receiving after a restore and keeps fragment sequences rising", () => {
  const input = new AgentInput();
  const partial: AgentFrame = { version: 7, kind: 3, requestId: 1, status: 0, payload: new Uint8Array(16384).fill(7) };
  input.enqueue(partial);
  input.enqueue({ version: 7, kind: 3, requestId: 2, status: 0, payload: Uint8Array.of(1) });
  const guest = new AgentFrameDecoder();
  let budget = 6000;
  input.flush(bytes => {
    const accepted = Math.min(budget, bytes.length);
    budget -= accepted;
    expect(guest.push(bytes.subarray(0, accepted))).toEqual([]);
    return accepted;
  });

  const { remainder, sequence } = input.resumeOutbound();
  const resumed = new AgentInput();
  resumed.resume(remainder, sequence);
  const next: AgentFrame = { version: 7, kind: 3, requestId: 3, status: 0, payload: new Uint8Array(8192).fill(9) };
  resumed.enqueue(next);
  const frames: AgentFrame[] = [];
  resumed.flush(bytes => { frames.push(...guest.push(bytes)); return bytes.length; });

  // The never-started frame goes with its request; the guest finishes the one it was receiving.
  expect(frames).toEqual([partial, next]);
  guest.finish();
  expect(input.hasPending).toBe(true);
});
