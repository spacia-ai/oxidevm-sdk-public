import { expect, it } from "vitest";
import { fixture, FRAME } from "./userspace-checkpoint.test-support.js";
import { VMError } from "../errors.js";

it.each([
  { ownerId: 12, owner: "process", cause: "ambiguous-legacy-membarrier", reason: 18 },
  { ownerId: 12, owner: "process", cause: "legacy-io-uring-workers-missing", reason: 19 },
  { ownerId: 14, owner: "files", cause: "legacy-copy-admission-missing", reason: 18 },
  { ownerId: 14, owner: "files", cause: "legacy-signal-poll-source-missing", reason: 19 },
  { ownerId: 14, owner: "files", cause: "legacy-creation-flag-missing", reason: 20 },
  { ownerId: 14, owner: "files", cause: "legacy-splice-admission-missing", reason: 21 },
  { ownerId: 17, owner: "vfs", cause: "legacy-posix-lock-owner-missing", reason: 6 },
])("retains the specific legacy refusal $cause", ({ ownerId, owner, cause, reason }) => {
  const { bridge, exports, memory } = fixture();
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_failure_read"] = () => {
    const frame = new DataView(memory.buffer, 1024, 24);
    [6, 4, ownerId, reason, 0, 0].forEach((word, index) => frame.setUint32(index * 4, word, true));
    return 0;
  };
  exports["oxidevm_userspace_checkpoint_frame_ptr"] = () => 1024;
  exports["oxidevm_userspace_checkpoint_frame_len"] = () => 24;
  let failure: unknown;
  try { bridge.beginPrecopy(new Uint8Array(32)); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ detail: { owner, nativeReason: reason, nativeCauses: [cause] } });
});

it("requests a fresh frozen fallback only for an initial speculative workspace publication", () => {
  const { bridge, exports, memory } = fixture();
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_capture_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_failure_read"] = () => {
    const frame = new DataView(memory.buffer, 1024, 24);
    [6, 4, 24, 1, 0, 0].forEach((word, index) => frame.setUint32(index * 4, word, true));
    return 0;
  };
  exports["oxidevm_userspace_checkpoint_frame_ptr"] = () => 1024;
  exports["oxidevm_userspace_checkpoint_frame_len"] = () => 24;
  let speculative: unknown;
  try { bridge.beginPrecopy(new Uint8Array(32)); } catch (error) { speculative = error; }
  if (!(speculative instanceof VMError)) throw new Error("Missing typed speculative refusal");
  expect(speculative.detail).toMatchObject({
    phase: "initial-round", domain: "runtime", owner: "workspace", nativeReason: 1, discardRounds: true,
  });
  let frozen: unknown;
  try { bridge.beginCapture(new Uint8Array(32)); } catch (error) { frozen = error; }
  if (!(frozen instanceof VMError)) throw new Error("Missing typed frozen refusal");
  expect(frozen.detail?.["discardRounds"]).toBeUndefined();
});

it("uses the authoritative clock token after a rejected speculative begin and retains zero-token refusal", () => {
  const { bridge, exports, memory } = fixture(1);
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_failure_read"] = () => {
    const frame = new DataView(memory.buffer, 1024, 24);
    [6, 4, 24, 1, 0, 0].forEach((word, index) => frame.setUint32(index * 4, word, true));
    return 0;
  };
  exports["oxidevm_userspace_checkpoint_frame_ptr"] = () => 1024;
  exports["oxidevm_userspace_checkpoint_frame_len"] = () => 24;
  expect(() => bridge.beginPrecopy(new Uint8Array(32))).toThrow(/could not begin/u);
  exports["oxidevm_userspace_checkpoint_quiesce_begin"] = () => 0n;
  expect(() => bridge.pauseClock()).toThrow(/could not quiesce/u);
  const resumed: bigint[] = [];
  exports["oxidevm_userspace_checkpoint_quiesce_begin"] = () => 31n;
  exports["oxidevm_userspace_checkpoint_quiesce_finish"] = (token: bigint) => { resumed.push(token); return 0; };
  expect(() => bridge.pauseClock()).not.toThrow();
  expect(() => bridge.pauseClock()).toThrow(/already quiesced/u);
  bridge.resumeClock(); bridge.resumeClock();
  expect(resumed).toEqual([31n]);
});

it("preserves bounded native begin phase and quota owner, without reserving a failed token", () => {
  const { bridge, exports, memory } = fixture();
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_failure_read"] = () => {
    const frame = new DataView(memory.buffer, 1024, 24);
    [6, 4, 14, 0x0106, 0, 0].forEach((word, index) => frame.setUint32(index * 4, word, true));
    return 0;
  };
  exports["oxidevm_userspace_checkpoint_frame_ptr"] = () => 1024;
  exports["oxidevm_userspace_checkpoint_frame_len"] = () => 24;
  let failure: unknown;
  try { bridge.beginPrecopy(new Uint8Array(32)); } catch (error) { failure = error; }
  if (!(failure instanceof VMError)) throw new Error("Missing typed admission failure");
  expect(failure.code).toBe("PROTOCOL_ERROR");
  expect(failure.detail).toEqual({
    reason: "checkpoint-begin-rejected", phase: "initial-round", domain: "runtime",
    owner: "files", nativeReason: 0x0106, scalar0: 0, scalar1: 0, nativeCauses: ["memory", "bounds"],
  });
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 9n;
  bridge.beginPrecopy(new Uint8Array(32)).abort();
});

it("rejects a truncated native begin diagnostic instead of trusting partial scalar fields", () => {
  const { bridge, exports } = fixture();
  exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => 0n;
  exports["oxidevm_userspace_checkpoint_failure_read"] = () => 0;
  exports["oxidevm_userspace_checkpoint_frame_len"] = () => 23;
  expect(() => bridge.beginPrecopy(new Uint8Array(32))).toThrow(/failure frame/u);
});
function input(chunks: readonly Uint8Array[]) {
  return { bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0), frames: (async function* () { for (const chunk of chunks) yield await Promise.resolve(chunk); })(), retire: () => Promise.resolve() };
}
it.each([1, 2, 3, 4, 5, 6, 7, 8])("streams native metadata version %s and sorted payloads through bounded CAS chunks, acknowledging only explicit commit", async version => {
  const { bridge, events, imported, payload } = fixture(0, 0, 0, version);
  const capture = bridge.beginCapture(new Uint8Array(32));
  const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  const sizes = await capture.transfer((area, index, bytes) => { expect(index).toBe(chunks[area].length); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); chunks[area].push(bytes); return Promise.resolve(); });
  expect(sizes).toEqual({ graphBytes: chunks.graph.reduce((n, b) => n + b.length, 0), payloadBytes: chunks.payloads.reduce((n, b) => n + b.length, 0) });
  expect(events).not.toContain("finish:1");
  capture.finish(true);
  const restore = bridge.beginRestore(new Uint8Array(32));
  await restore.read(input(chunks.graph), input(chunks.payloads));
  expect(events).not.toContain("published");
  expect(imported.every(bytes => bytes.length <= FRAME)).toBe(true);
  expect(imported.reduce((n, b) => n + b.length, 0)).toBe(payload.length);
  expect(imported.every(bytes => bytes.every(byte => byte === 0x5a))).toBe(true);
  restore.complete();
  expect(events.slice(-2)).toEqual(["jit-invalidated", "published"]);
});
it("aborts quota-failed tokens and cancelled transfers without acknowledging capture", async () => {
  const failed = fixture(3);
  expect(() => failed.bridge.beginCapture(new Uint8Array(32))).toThrow();
  expect(failed.events).toEqual(["capture", "abort"]);
  const { bridge, events } = fixture();
  const capture = bridge.beginCapture(new Uint8Array(32));
  const controller = new AbortController(); controller.abort();
  await expect(capture.transfer(() => Promise.resolve(), controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  capture.abort();
  expect(events).toEqual(["capture", "abort"]);
});

it("rejects malformed stream framing before the destructive restore cut and retires both inputs", async () => {
  const { bridge, events } = fixture();
  const capture = bridge.beginCapture(new Uint8Array(32));
  const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); });
  capture.finish(false);
  const graph = chunks.graph[0];
  if (graph === undefined) throw new Error("missing graph");
  new DataView(graph.buffer, graph.byteOffset, graph.byteLength).setUint32(12, 1, true);
  let retirements = 0;
  const restore = bridge.beginRestore(new Uint8Array(32));
  await expect(restore.read({ ...input(chunks.graph), retire: () => { retirements++; return Promise.resolve(); } }, {
    ...input(chunks.payloads), retire: () => { retirements++; return Promise.resolve(); },
  })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(retirements).toBe(2);
  expect(events).not.toContain("allocated");
  restore.abort();
});
it("reports recovery-required for corrupt payload data after native heap replacement", async () => {
  const { bridge } = fixture();
  const capture = bridge.beginCapture(new Uint8Array(32));
  const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); });
  capture.finish(false);
  const payload = chunks.payloads[0];
  if (payload === undefined) throw new Error("missing payload");
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(16, 0n, true);
  const restore = bridge.beginRestore(new Uint8Array(32));
  await expect(restore.read(input(chunks.graph), input(chunks.payloads))).rejects.toMatchObject({ detail: { recoveryRequired: true } });
  expect(restore.recoveryRequired).toBe(true);
  expect(() => restore.abort()).toThrow(/recovery/u);
});

it("retains a failed begin token until native cancellation is confirmed", () => {
  const { bridge, events } = fixture(3, 1);
  let failure: unknown;
  try { bridge.beginCapture(new Uint8Array(32)); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ detail: { reason: "checkpoint-capture-cleanup-failed", cleanupFailed: true } });
  expect(() => bridge.beginCapture(new Uint8Array(32))).toThrow(/busy/u);
  bridge.retryAbort();
  expect(events).toEqual(["capture", "abort", "abort"]);
});
it("does not request recovery when native metadata admission refuses before retiring the old runtime", async () => {
  const { bridge, events } = fixture(0, 0, 1);
  const capture = bridge.beginCapture(new Uint8Array(32));
  const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); });
  capture.finish(false);
  const restore = bridge.beginRestore(new Uint8Array(32));
  await expect(restore.read(input(chunks.graph), input(chunks.payloads))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(restore.recoveryRequired).toBe(false);
  restore.abort();
  expect(events.at(-1)).toBe("abort");
});
it("cancellation retires a stalled producer so the native pre-cut owner can resume", async () => {
  const { bridge, events } = fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<IteratorResult<Uint8Array>>();
  const payload = { bytes: 16, frames: { [Symbol.asyncIterator]() { return { next() { entered.resolve(undefined); return released.promise; } }; } },
    retire: () => { released.resolve({ done: true, value: undefined }); return Promise.resolve(); } };
  const restore = bridge.beginRestore(new Uint8Array(32));
  const reading = restore.read(input([]), payload, controller.signal);
  await entered.promise; controller.abort();
  await expect(reading).rejects.toMatchObject({ code: "ABORTED" });
  restore.abort(); expect(events).toEqual(["restore", "abort"]);
});

it("preserves the original admission error when producer retirement also fails", async () => {
  const { bridge, events } = fixture(), restore = bridge.beginRestore(new Uint8Array(32));
  const malformed = new Uint8Array(16);
  await expect(restore.read(input([]), { ...input([malformed]), retire: () => Promise.reject(new Error("retire failed")) }))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(events).not.toContain("allocated");
  restore.abort();
});

it("admits same-instance recovery only after the original heap has been retired", async () => {
  const { bridge, exports, events } = fixture();
  exports["oxidevm_userspace_checkpoint_recovery_begin"] = () => { events.push("recovery"); return 9n; };
  expect(() => bridge.beginRecovery(new Uint8Array(32))).toThrow();
  const capture = bridge.beginCapture(new Uint8Array(32));
  const chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); }); capture.finish(false);
  const restore = bridge.beginRestore(new Uint8Array(32));
  await restore.read(input(chunks.graph), input(chunks.payloads));
  const recovery = bridge.beginRecovery(new Uint8Array(32));
  await recovery.read(input(chunks.graph), input(chunks.payloads)); recovery.complete();
  expect(events.slice(-3)).toEqual(["allocated", "jit-invalidated", "published"]);
});

it("validates attachment output cuts and reads terminal geometry from the unpublished native candidate", async () => {
  const { bridge, exports, frame } = fixture();
  const observed: (number | bigint)[][] = [];
  exports["oxidevm_userspace_checkpoint_attachment_validate"] = (...args: (number | bigint)[]) => { observed.push(args); return 0; };
  exports["oxidevm_userspace_checkpoint_attachment_terminal"] = () => {
    const bytes = new Uint8Array(16), view = new DataView(bytes.buffer); view.setUint32(0, 101, true); view.setUint32(4, 37, true); return frame(bytes);
  };
  const capture = bridge.beginCapture(new Uint8Array(32)), chunks: { graph: Uint8Array[]; payloads: Uint8Array[] } = { graph: [], payloads: [] };
  await capture.transfer((area, _index, bytes) => { chunks[area].push(bytes); return Promise.resolve(); }); capture.finish(false);
  const restore = bridge.beginRestore(new Uint8Array(32));
  expect(() => restore.validateAttachment({ pid: 12, terminal: undefined })).toThrow();
  await restore.read(input(chunks.graph), input(chunks.payloads));
  expect(restore.validateAttachment({ pid: 12, terminal: { columns: 80, rows: 24 }, pending: { stream: "stderr", count: 3 } })).toEqual({ columns: 101, rows: 37 });
  expect(observed).toEqual([[8n, 12, 1, 0n, 3n]]);
  expect(restore.validateAttachment({ pid: 13, terminal: undefined })).toBeUndefined();
  exports["oxidevm_userspace_checkpoint_attachment_terminal"] = () => frame(new Uint8Array());
  expect(restore.validateAttachment({ pid: 12, terminal: { columns: 80, rows: 24 } })).toBeUndefined();
});

it("retains the native quiesce token until confirmed resume and never invents elapsed guest time", () => {
  const { bridge, exports } = fixture();
  let attempts = 0;
  const resumed: bigint[] = [];
  exports["oxidevm_userspace_checkpoint_quiesce_begin"] = () => 31n;
  exports["oxidevm_userspace_checkpoint_quiesce_finish"] = (token: bigint) => { resumed.push(token); return attempts++ === 0 ? 2 : 0; };
  bridge.pauseClock();
  expect(() => bridge.pauseClock()).toThrow();
  expect(() => bridge.resumeClock()).toThrow();
  bridge.resumeClock(); bridge.resumeClock();
  expect(resumed).toEqual([31n, 31n]);
});

it("pairs an incremental precopy with the exact native committed baseline token", () => {
  const { bridge, exports, events } = fixture();
  exports["oxidevm_userspace_checkpoint_baseline"] = () => 7n;
  exports["oxidevm_userspace_checkpoint_precopy_begin_incremental"] = (expected: bigint) => { expect(expected).toBe(7n); events.push("incremental"); return 9n; };
  expect(bridge.baseline).toBe(7n);
  expect(() => bridge.beginPrecopyIncremental(new Uint8Array(32), 0n)).toThrow();
  const capture=bridge.beginPrecopyIncremental(new Uint8Array(32),7n);capture.abort();
  expect(events).toEqual(["incremental","abort"]);
});

it("stages verified selected and original recovery image identities without guest-derived policy", () => {
  const { bridge, exports, memory } = fixture();
  let staged=0;
  exports["oxidevm_userspace_staging_resize"]=(length:number)=>{staged=length;return 0;};
  exports["oxidevm_userspace_checkpoint_restore_begin"]=()=>{
    const bytes=new Uint8Array(memory.buffer,0,staged);
    expect(new TextDecoder().decode(bytes.subarray(0,4))).toBe("OXUR");
    expect(bytes.subarray(8,40)).toEqual(new Uint8Array(32).fill(2));
    expect(bytes.subarray(40,72)).toEqual(new Uint8Array(32).fill(1));
    expect(bytes[72]).toBe(1);expect(bytes.subarray(73)).toEqual(new Uint8Array(32).fill(3));return 8n;
  };
  const selected=new Uint8Array(32).fill(2),original=new Uint8Array(32).fill(1),root=new Uint8Array(32).fill(3);
  const replacement=bridge.beginRestore(selected,original,root);expect(staged).toBe(105);replacement.abort();
  expect(()=>bridge.beginRestore(selected,original,new Uint8Array(31))).toThrow();
});

it("builds the unpublished native candidate once before reconciliation and publication", async () => {
  const { bridge, exports, events }=fixture();
  exports["oxidevm_userspace_checkpoint_restore_prepare"]=()=>{events.push("prepared");return 0;};
  const capture=bridge.beginCapture(new Uint8Array(32)),chunks:{graph:Uint8Array[];payloads:Uint8Array[]}={graph:[],payloads:[]};
  await capture.transfer((area,_index,bytes)=>{chunks[area].push(bytes);return Promise.resolve();});capture.finish(false);
  const restore=bridge.beginRestore(new Uint8Array(32));expect(()=>restore.prepare()).toThrow();
  await restore.read(input(chunks.graph),input(chunks.payloads));restore.prepare();restore.prepare();
  expect(events.filter(event=>event==="prepared")).toHaveLength(1);expect(events).not.toContain("published");
  restore.complete();expect(events.slice(-3)).toEqual(["prepared","jit-invalidated","published"]);
});
