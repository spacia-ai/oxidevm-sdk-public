import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFilesystemRecord } from "../../userspace-rootfs-record.js";
import { workspaceBytesInput } from "../workspace-stream.js";
import { AgentCapability, AgentKind, type AgentProtocolVersion } from "../../agent-protocol.js";
import { decodeWorkspaceRestore } from "../../protocol/workspace-restore.js";
import { emptyReply, helloReply, scriptedGuest } from "./guest-agent.test-support.js";

function record(kind: "snapshot" | "delta"): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(kind === "snapshot" ? "OXRF" : "OXWD"));
  new DataView(bytes.buffer).setUint16(4, kind === "snapshot" ? 9 : 4, true);
  return bytes;
}

it("keeps ordinary timestamp-only file and hardlink handoff available on existing v7 guests", async () => {
  const capabilities = 3 | AgentCapability.workspaceTimes;
  const { agent, received } = scriptedGuest({ version: 7, capabilities, answer: request => {
    if (request.kind === AgentKind.hello) return [helloReply(request, capabilities)];
    const reply = emptyReply(request);
    if (request.kind === AgentKind.workspaceRestore && decodeWorkspaceRestore(request.payload, request.version).kind === "status") {
      return [{ ...reply, payload: Uint8Array.of(1, ...new Uint8Array(16)) }];
    }
    return [reply];
  } });
  await agent.wait(1, 1000);
  const fixture = readFileSync(new URL("../../../../../../tests/fixtures/workspace/timestamps.hex", import.meta.url), "utf8")
    .split("\n").find(line => line.startsWith("snapshot-v8 "));
  if (fixture === undefined) throw new Error("missing native timestamp fixture");
  const bytes = Uint8Array.from(Buffer.from(fixture.slice("snapshot-v8 ".length), "hex"));
  await agent.applyWorkspaceStream(2, "snapshot", workspaceBytesInput(bytes));
  const chunks = received.filter(frame => frame.kind === AgentKind.workspaceRestore)
    .map(frame => decodeWorkspaceRestore(frame.payload, frame.version)).filter(operation => operation.kind === "chunk");
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.data).toEqual(bytes);
  expect(decodeFilesystemRecord(bytes, "snapshot").map(entry => [entry.tag, entry.ownership, entry.times]))
    .toEqual([1, 4].map(tag => [tag, { uid: 1000, gid: 1000 }, { accessNs: "12123456789", modificationNs: "23987654321" }]));
  expect(received.some(frame => frame.kind === AgentKind.workspaceRestore && decodeWorkspaceRestore(frame.payload, frame.version).kind === "commit")).toBe(true);
});

it.each([3, 4, 5, 6, 7] satisfies AgentProtocolVersion[])("keeps guest v%s healthy when rejecting unsupported buffered inode metadata", async version => {
  const { agent, received } = scriptedGuest({ version, capabilities: 3 });
  await agent.wait(1, 1000);
  for (const kind of ["snapshot", "delta"] as const) {
    await expect(kind === "snapshot" ? agent.applyWorkspace(2, record(kind)) : agent.applyWorkspaceDelta(2, record(kind)))
      .rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  }
  expect(received.map(frame => frame.kind)).toEqual([AgentKind.hello]);
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
});

it("aborts a fragmented rich stream on an older guest without committing or fencing recovery", async () => {
  const { agent, received } = scriptedGuest({ version: 7, capabilities: 3 });
  await agent.wait(1, 1000);
  const bytes = record("snapshot"), retire = vi.fn(async () => {});
  await expect(agent.applyWorkspaceStream(2, "snapshot", { bytes: bytes.length, source: () => ({ retire,
    frames: (async function* () { for (const byte of bytes) yield await Promise.resolve(Uint8Array.of(byte)); })(),
  }) })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  const operations = received.filter(frame => frame.kind === AgentKind.workspaceRestore)
    .map(frame => decodeWorkspaceRestore(frame.payload, frame.version).kind);
  expect(operations).toContain("abort");
  expect(operations).not.toContain("commit");
  expect(retire).toHaveBeenCalledTimes(1);
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
});

it("admits buffered and streamed records only with the implemented metadata capability", async () => {
  const capabilities = 3 | AgentCapability.workspaceMetadata;
  const { agent, received } = scriptedGuest({ version: 7, capabilities, answer: request => {
    if (request.kind === AgentKind.hello) return [helloReply(request, capabilities)];
    const reply = emptyReply(request);
    if (request.kind === AgentKind.workspaceRestore && decodeWorkspaceRestore(request.payload, request.version).kind === "status") {
      return [{ ...reply, payload: Uint8Array.of(1, ...new Uint8Array(16)) }];
    }
    return [reply];
  } });
  await agent.wait(1, 1000);
  await agent.applyWorkspace(2, record("snapshot"));
  await agent.applyWorkspaceDelta(2, record("delta"));
  const bytes = record("snapshot"), retire = vi.fn(async () => {});
  await agent.applyWorkspaceStream(2, "snapshot", { bytes: bytes.length, source: () => ({ retire,
    frames: (async function* () { yield await Promise.resolve(bytes); })(),
  }) });
  expect(received.some(frame => frame.kind === AgentKind.workspaceRestore && decodeWorkspaceRestore(frame.payload, frame.version).kind === "commit")).toBe(true);
  expect(retire).toHaveBeenCalledTimes(1);
});
