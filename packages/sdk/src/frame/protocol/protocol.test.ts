import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import {
  FRAME_PROTOCOL_VERSION, decodeFrameConnect, decodeFrameConnectReply, decodeFrameReady, frameConnect, frameReady, isAcceptableEmbedder, negotiateFrameProtocol,
} from "./handshake.js";
import { decodeFrameMessage, frameRequest } from "./requests.js";
import { decodeFrameReply, frameEvent, frameFailure, frameResult } from "./replies.js";
import { decodeProcessFrameMessage, decodeProcessPageMessage, encodeExit, exitFromWire, MAX_PROCESS_CHUNK } from "./process-io.js";
import { decodeBackupCall, decodeBackupCallReply } from "./backup-port.js";
import { decodeBootProgress, decodeLicenseStatus, decodeSnapshotEvent, decodeStart, decodeVMDescription, encodeSnapshotEvent } from "./values.js";

it("never accepts a legacy free admission as authorization from a new frame", () => {
  expect(code(() => decodeLicenseStatus({ tier: "free" }))).toBe("PROTOCOL_ERROR");
  expect(code(() => decodeLicenseStatus({ tier: "free", rejected: "expired" }))).toBe("PROTOCOL_ERROR");
  expect(code(() => negotiateFrameProtocol({ kind: "oxidevm-runtime-ready", protocol: { min: 14, max: 14 } }))).toBe("FEATURE_NOT_AVAILABLE");
});

it("preserves fractional snapshot timings across the hosted boundary",()=>{
 const event={type:"save-finished",kind:"named",snapshot:{id:"123e4567-e89b-42d3-a456-426614174000",createdAt:"2026-10-14T00:00:00.000Z"},pauseMilliseconds:0.25,durationMilliseconds:3.5};
 expect(decodeSnapshotEvent(event)).toEqual(event);
});

function code(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof VMError) return error.code; throw error; }
  throw new Error("expected a VMError");
}

it("rejects the previous frame protocol before it can drop trace requests", () => {
  expect(FRAME_PROTOCOL_VERSION).toBe(16);
  expect(code(() => negotiateFrameProtocol({ kind: "oxidevm-runtime-ready", protocol: { min: 11, max: 11 } }))).toBe("FEATURE_NOT_AVAILABLE");
  // Protocol 16 adds acceleration notices; a protocol 15 frame would reject the request.
  expect(code(() => negotiateFrameProtocol({ kind: "oxidevm-runtime-ready", protocol: { min: 15, max: 15 } }))).toBe("FEATURE_NOT_AVAILABLE");
});

const image = { id: "alpine", version: "1", mode: "userspace", manifestSHA256: "a".repeat(64), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "k" } as const;
const description = {
  mode: "userspace", image,
  workspace: { id: "ws", persistence: { kind: "persistent", backend: "opfs", browserRetention: "best-effort" } },
  capabilities: { previews: { available: false, reason: "not-configured" }, snapshots: { available: false, reason: "mode-unsupported" }, maximumVcpus: 1, commandAcceleration: { available: true }, crossOriginIsolated: true },
  network: { kind: "off" },
  license: { tier: "development" },
  start: { kind:"booted",reason:"first-start",workspaceDetails: { state: "in-sync", conflicts: [], omittedConflicts: 0 } },
};

it("carries command acceleration in the VM description, including its runtime-unsupported reason", () => {
  const unsupported = { available: false, reason: "runtime-unsupported" } as const;
  expect(decodeVMDescription({ ...description, capabilities: { ...description.capabilities, commandAcceleration: unsupported } }).capabilities.commandAcceleration)
    .toEqual(unsupported);
  // Protocol 13 capabilities omitted this field; the exact-key decoder refuses them rather than guessing.
  const previous = { previews: description.capabilities.previews, snapshots: description.capabilities.snapshots, maximumVcpus: 1, crossOriginIsolated: true };
  expect(code(() => decodeVMDescription({ ...description, capabilities: previous }))).toBe("PROTOCOL_ERROR");
});

describe("frame handshake", () => {
  it("negotiates the one version both sides speak and refuses a frame that speaks another", () => {
    const ready = decodeFrameReady(frameReady());
    if (ready === undefined) throw new Error("ready was not decoded");
    expect(negotiateFrameProtocol(ready)).toBe(FRAME_PROTOCOL_VERSION);
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: FRAME_PROTOCOL_VERSION + 1, max: FRAME_PROTOCOL_VERSION + 2 } }))).toBe("FEATURE_NOT_AVAILABLE");
    // A frame of the previous release, which speaks only protocol 1, is refused before connecting.
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 1, max: 1 } }))).toBe("FEATURE_NOT_AVAILABLE");
    // Protocol 6 preserves byte progress and distinguishes checkpoint downloads.
    expect(FRAME_PROTOCOL_VERSION).toBe(16);
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 9, max: 9 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 8, max: 8 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 7, max: 7 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 4, max: 4 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 3, max: 3 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => negotiateFrameProtocol({ ...ready, protocol: { min: 2, max: 2 } }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => decodeFrameConnectReply({ v: 2, type: "accepted", engineReleaseId: "b".repeat(64) }))).toBe("FEATURE_NOT_AVAILABLE");
  });
  it("ignores unrelated window messages and rejects malformed ready messages", () => {
    expect(decodeFrameReady({ kind: "something-else" })).toBeUndefined();
    expect(decodeFrameReady("text")).toBeUndefined();
    expect(code(() => decodeFrameReady({ ...frameReady(), extra: 1 }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameReady({ kind: "oxidevm-runtime-ready", protocol: { min: 3, max: 2 } }))).toBe("PROTOCOL_ERROR");
  });
  it("requires exactly one port and a bounded SDK version on connect", () => {
    const { port1, port2 } = new MessageChannel();
    expect(decodeFrameConnect(frameConnect("0.1.0-alpha.3"), [port1])?.port).toBe(port1);
    expect(code(() => decodeFrameConnect(frameConnect("0.1.0-alpha.3"), []))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameConnect(frameConnect("0.1.0-alpha.3"), [port1, port2]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameConnect(frameConnect("x".repeat(65)), [port1]))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameConnect({ ...frameConnect("1"), license: "secret" }, [port1]))).toBe("PROTOCOL_ERROR");
    port1.close(); port2.close();
  });
  it("decodes accepted and rejected connect replies", () => {
    const v = FRAME_PROTOCOL_VERSION;
    expect(decodeFrameConnectReply({ v, type: "accepted", engineReleaseId: "b".repeat(64) })).toMatchObject({ type: "accepted" });
    expect(decodeFrameConnectReply({ v, type: "rejected", error: { code: "PERMISSION_DENIED", message: "no" } })).toMatchObject({ type: "rejected", error: { code: "PERMISSION_DENIED" } });
    expect(code(() => decodeFrameConnectReply({ v, type: "accepted", engineReleaseId: "short" }))).toBe("PROTOCOL_ERROR");
  });
  it("refuses a frame that accepts in another protocol version, and keeps the reason a frame of any version rejects with", () => {
    expect(code(() => decodeFrameConnectReply({ v: 1, type: "accepted", engineReleaseId: "b".repeat(64) }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(code(() => decodeFrameConnectReply({ v: FRAME_PROTOCOL_VERSION + 1, type: "accepted", engineReleaseId: "b".repeat(64) }))).toBe("FEATURE_NOT_AVAILABLE");
    expect(decodeFrameConnectReply({ v: 1, type: "rejected", error: { code: "FEATURE_NOT_AVAILABLE", message: "old" } })).toMatchObject({ type: "rejected", error: { code: "FEATURE_NOT_AVAILABLE" } });
  });
  it("lets only https pages and this machine's http pages embed the frame, never the frame itself", () => {
    const frame = "https://run.oxidevm.dev";
    expect(isAcceptableEmbedder("https://app.example.com", frame)).toBe(true);
    expect(isAcceptableEmbedder("http://localhost:5173", frame)).toBe(true);
    expect(isAcceptableEmbedder("http://127.0.0.1:4173", frame)).toBe(true);
    expect(isAcceptableEmbedder("http://app.example.com", frame)).toBe(false);
    expect(isAcceptableEmbedder(frame, frame)).toBe(false);
    expect(isAcceptableEmbedder("null", frame)).toBe(false);
    expect(isAcceptableEmbedder("https://app.example.com/path", frame)).toBe(false);
  });
});

describe("frame requests", () => {
  it("round-trips every envelope and keeps the fields the page sent", () => {
    expect(decodeFrameMessage(frameRequest(7, { type: "workspace.write", path: "/a", data: new Uint8Array([1]) }))).toEqual({ type: "workspace.write", id: 7, path: "/a", data: new Uint8Array([1]) });
    expect(decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 3, type: "cancel" })).toEqual({ type: "cancel", id: 3 });
  });
  it.each([
    { v: 1, id: 1, type: "dispose" },
    { v: FRAME_PROTOCOL_VERSION + 1, id: 1, type: "dispose" },
    { v: FRAME_PROTOCOL_VERSION, id: 0, type: "dispose" },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "unknown" },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "dispose", extra: true },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "workspace.read" },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "workspace.write", path: "/a", data: "text" },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "exposePort", port: 70_000 },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "spawn", spec: { command: "sh" }, io: {} },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "snapshots.capture", label: "x", kind: "shipped" },
    { v: FRAME_PROTOCOL_VERSION, id: 1, type: "snapshots.inspect", file: "not a blob" },
  ])("rejects a malformed request: %j", message => {
    expect(["PROTOCOL_ERROR", "INVALID_ARGUMENT"]).toContain(code(() => decodeFrameMessage(message)));
  });
  it("type-checks spawn specs and leaves command validation to the VM", () => {
    const { port1, port2 } = new MessageChannel();
    expect(decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "spawn", spec: { command: "sh", args: ["-c", "x"], env: { A: "1" }, terminal: { columns: 80, rows: 24 } }, io: port1 })).toMatchObject({ spec: { command: "sh", terminal: { columns: 80, rows: 24 } } });
    expect(code(() => decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "spawn", spec: { command: "sh", args: [1] }, io: port1 }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "spawn", spec: { command: "sh", signal: null }, io: port1 }))).toBe("PROTOCOL_ERROR");
    port1.close(); port2.close();
  });
});

describe("frame replies", () => {
  it("decodes results, failures and events and rejects anything else", () => {
    expect(decodeFrameReply(frameResult(1, 5))).toEqual({ type: "result", id: 1, ok: true, value: 5 });
    expect(decodeFrameReply(frameFailure(2, new VMError("QUOTA_EXCEEDED", "full", { bytes: 1 })))).toEqual({ type: "result", id: 2, ok: false, error: { code: "QUOTA_EXCEEDED", message: "full", detail: { bytes: 1 } } });
    expect(decodeFrameReply(frameEvent(3, { phase: "ready" }))).toEqual({ type: "event", id: 3, event: { phase: "ready" } });
    expect(code(() => decodeFrameReply({ ...frameResult(1, 5), extra: 1 }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameReply({ v: FRAME_PROTOCOL_VERSION, type: "result", id: 1, ok: "yes", value: 1 }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameReply({ ...frameResult(1, 5), v: 1 }))).toBe("PROTOCOL_ERROR");
  });
});

describe("process port messages", () => {
  it("bounds chunks and credits and names exits by number", () => {
    expect(decodeProcessFrameMessage({ type: "data", stream: "stdout", bytes: new Uint8Array(4) })).toMatchObject({ type: "data" });
    expect(code(() => decodeProcessFrameMessage({ type: "data", stream: "stdout", bytes: new Uint8Array(MAX_PROCESS_CHUNK + 1) }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeProcessFrameMessage({ type: "data", stream: "stdin", bytes: new Uint8Array(1) }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeProcessPageMessage({ type: "credit", stream: "stdout", bytes: 0 }))).toBe("PROTOCOL_ERROR");
    expect(decodeProcessPageMessage({ type: "control", id: 1, op: "kill", signal: "SIGINT", scope: "process-group" })).toMatchObject({ op: "kill", signal: "SIGINT" });
    expect(code(() => decodeProcessPageMessage({ type: "control", id: 1, op: "kill", signal: "SIGNOPE", scope: "process" }))).toBe("INVALID_ARGUMENT");
    expect(exitFromWire(encodeExit({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 }))).toEqual({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 });
    expect(code(() => decodeProcessFrameMessage({ type: "exit", exit: { kind: "exited", code: 256 } }))).toBe("PROTOCOL_ERROR");
  });
  it("decodes backup destination calls and replies", () => {
    expect(decodeBackupCall({ type: "write", id: 1, bytes: new Uint8Array(3) })).toMatchObject({ type: "write" });
    expect(code(() => decodeBackupCall({ type: "write", id: 1, bytes: [1] }))).toBe("PROTOCOL_ERROR");
    expect(decodeBackupCallReply({ type: "reply", id: 1, error: null })).toEqual({ type: "reply", id: 1, error: null });
  });
});

describe("frame values", () => {
  it("decodes a VM description and refuses a mismatched or incomplete one", () => {
    expect(decodeVMDescription(description)).toMatchObject({ mode: "userspace", workspace: { id: "ws" } });
    expect(code(() => decodeVMDescription({ ...description, mode: "system" }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeVMDescription({ ...description, image: { ...image, signatureVerified: false } }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeVMDescription({ ...description, start: { kind: "started", reason: "first-start" } }))).toBe("PROTOCOL_ERROR");
  });
  it("carries cold workspace details in the common start and rejects contradictions", () => {
    const reconciled = { state: "conflict-preserved", conflicts: [{ reason: "changed-in-both", path: "/workspace/app.ts" }], omittedConflicts: 0, preserved: { id: "2", reason: "content-unavailable" } };
    expect(decodeVMDescription({ ...description, start:{...description.start,workspaceDetails:reconciled} }).start.workspaceDetails).toEqual(reconciled);
    const {start:_omitted,...incomplete}=description;void _omitted;
    expect(code(()=>decodeVMDescription(incomplete))).toBe("PROTOCOL_ERROR");
    for (const workspaceDetails of [
      {...reconciled,state:"reconciled"},
      {...reconciled,conflicts:[{reason:"changed-in-both",path:"/etc/passwd"}]},
      {...reconciled,preserved:{id:"../x",reason:"unreadable"}},
    ]) expect(code(()=>decodeVMDescription({...description,start:{...description.start,workspaceDetails}}))).toBe("PROTOCOL_ERROR");
  });
  it("decodes starts with resumed terminals as data and rejects unknown reasons", () => {
    const snapshot = { ref: { id: "3f1b5f7e-6a1d-4c2b-9e5f-2a7f0d9c1b3e", createdAt: "2026-10-09T10:00:00.000Z" }, kind: "automatic", capturedAtUnixMs: 1, profile: null, bytes: { ram: 1, disk: 1, unique: 1 }, resumable: true };
    expect(decodeStart({ kind: "resumed", snapshot, appData: null, terminals: [{ source: "process", key: "p1", command: "bash", screenTail: new Uint8Array(1) }], newerFilesDropped: false, workspace: "in-sync" })).toMatchObject({ terminals: [{ key: "p1" }] });
    expect(code(() => decodeStart({ kind: "booted", reason: "because" }))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeStart({ kind: "resumed", snapshot, appData: null, terminals: [{ source: "process", key: "p1", command: "bash", screenTail: new Uint8Array(1), attach: 1 }], newerFilesDropped: false, workspace: "in-sync" }))).toBe("PROTOCOL_ERROR");
  });
  it("carries a failed save's error as data and restores it as a VMError", () => {
    const decoded = decodeSnapshotEvent(encodeSnapshotEvent({ type: "save-failed", kind: "automatic", error: new VMError("QUOTA_EXCEEDED", "full") }));
    expect(decoded.type === "save-failed" && decoded.error).toBeInstanceOf(VMError);
  });
  it("decodes every boot progress phase and rejects others", () => {
    expect(decodeBootProgress({ phase: "download", asset: "image", completedBytes: 1, totalBytes: null })).toMatchObject({ phase: "download" });
    expect(code(() => decodeBootProgress({ phase: "download", asset: "kernel", completedBytes: 1, totalBytes: 2 }))).toBe("PROTOCOL_ERROR");
  });

  it("preserves bounded restore byte progress and distinguishes checkpoint downloads", () => {
    const open = { phase: "restore", step: "open", completedBytes: 64, totalBytes: 128 };
    expect(decodeBootProgress(open)).toEqual(open);
    const download = { phase: "download", asset: "restore-point", completedBytes: 1, totalBytes: 2 };
    expect(decodeBootProgress(download)).toEqual(download);
    for (const invalid of [
      { ...open, completedBytes: -1 }, { ...open, completedBytes: 129 },
      { ...open, totalBytes: undefined }, { ...open, step: "wake" },
    ]) expect(code(() => decodeBootProgress(invalid))).toBe("PROTOCOL_ERROR");
  });
});

it("frame protocol 15 carries common starts and Userspace cold-workspace details", () => {
  expect(FRAME_PROTOCOL_VERSION).toBeGreaterThanOrEqual(15);
  const { start: previous, ...common } = description;
  const details=previous.workspaceDetails;
  const start = { kind: "booted", reason: "first-start", workspaceDetails: details };
  expect(decodeVMDescription({ ...common, start })).toMatchObject({ mode: "userspace", start });
  expect(code(() => decodeVMDescription({ ...common, start: { ...start, workspaceDetails: { ...details, state: "bad" } } }))).toBe("PROTOCOL_ERROR");
});
