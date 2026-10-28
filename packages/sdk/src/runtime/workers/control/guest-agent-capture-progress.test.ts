import { expect, it, vi } from "vitest";
import { AgentCapability, AgentKind, AgentPayloadWriter } from "../../agent-protocol.js";
import { decodeWorkspaceCapture, encodeWorkspaceCaptureProgress } from "../../protocol/workspace-capture.js";
import { emptyReply, helloReply, scriptedGuest } from "./guest-agent.test-support.js";

it.each([false, true])("keeps streamed captures compatible with progress capability %s", async enabled => {
  const capabilities = 3 | (enabled ? AgentCapability.workspaceCaptureProgress : 0);
  const guest = scriptedGuest({ version: 7, capabilities, answer: request => {
    if (request.kind === AgentKind.hello) return [helloReply(request, capabilities)];
    if (request.kind !== AgentKind.workspaceCapture) return [emptyReply(request)];
    const reply = emptyReply(request), operation = decodeWorkspaceCapture(request.payload, 7);
    if (operation.kind !== "begin") return [reply];
    return [...(enabled ? [{ ...reply, kind: AgentKind.workspaceCaptureProgress,
      payload: encodeWorkspaceCaptureProgress({ phase: "scan", entries: 256 }) }] : []),
    { ...reply, payload: new AgentPayloadWriter().u64(12n).finish() }];
  } });
  await guest.agent.wait(1, 1000);
  guest.session.active = true;
  const receive = vi.fn(), pending = guest.agent.captureWorkspace(2, "snapshot", new AbortController().signal, receive);
  guest.drain();
  const capture = await pending;
  expect(receive.mock.calls).toEqual(enabled ? [[{ phase: "scan", entries: 256 }]] : []);
  const retiring = capture.retire();
  guest.drain();
  await retiring;
  const begin = guest.received.find(frame => frame.kind === AgentKind.workspaceCapture);
  if (begin === undefined) throw new Error("Missing capture begin");
  guest.send({ version: 7, kind: AgentKind.workspaceCaptureProgress, requestId: begin.requestId, status: 0,
    payload: encodeWorkspaceCaptureProgress({ phase: "scan", entries: 512 }) });
  const reading = guest.agent.readFile(3, "file");
  const rejected = expect(reading).rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(() => guest.drain()).toThrow();
  guest.agent.executionStopped();
  await rejected;
});

it("drops capture progress from before the restore cut and rejects unknown current transfers", async () => {
  const capabilities = 3 | AgentCapability.resume | AgentCapability.workspaceCaptureProgress;
  const guest = scriptedGuest({ version: 7, capabilities });
  await guest.agent.wait(1, 1000);
  const state = guest.agent.resumeState(new Uint8Array());
  guest.agent.resume(guest.core, state);
  await guest.agent.wait(2, 1000);
  const frame = { version: 7 as const, kind: AgentKind.workspaceCaptureProgress, requestId: 1, status: 0,
    payload: encodeWorkspaceCaptureProgress({ phase: "scan", entries: 256 }) };
  guest.session.active = true;
  guest.send(frame);
  const reading = guest.agent.readFile(3, "file");
  guest.drain(); await reading;
  expect(guest.agent.droppedFrames).toBe(1);
  guest.send({ ...frame, requestId: state.nextRequestId + 100 });
  const pending = guest.agent.readFile(4, "file");
  const rejected = expect(pending).rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(() => guest.drain()).toThrow();
  guest.agent.executionStopped(); await rejected;
});
