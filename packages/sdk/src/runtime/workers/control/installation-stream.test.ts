import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { AssistanceTraffic } from "./assistance-traffic.js";
import { installationStreams } from "./installation-stream.js";
import { CAPTURE_READ_WINDOW } from "./installation-capture.js";
import { CAPTURE_DATA_LANE, INSTALLATION_DATA_LANE } from "../../protocol/assistance-installation.js";
import type { InstallationRequest } from "../../protocol/assistance-installation.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1 };

it.each([false, true])("still retires producers when terminal draining fails (synchronous=%s)", async synchronous => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    return Promise.resolve(reply(request, { kind: "stopped" }));
  } };
  const error = new Error("terminal delivery uncertain");
  const pipe = installationStreams(agent, identity, 1, traffic, { beforeClose: () => {
    if (synchronous) throw error;
    return Promise.reject(error);
  } });
  const closing = pipe.close();
  expect(pipe.close()).toBe(closing);
  await expect(closing).rejects.toBe(error);
  expect(requests.map(request => request.operation.kind)).toEqual(["stop"]);
  expect(traffic.pendingBytes).toBe(0);
});

it("retains supervision after writer retirement until explicit release", async () => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    return Promise.resolve(reply(request, request.operation.kind === "retire" ? { kind: "retired" } : { kind: "stopped" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const retired = pipe.retire();
  expect(pipe.retire()).toBe(retired);
  await retired;
  await pipe.close();
  expect(requests.map(request => [request.sequence, request.operation.kind])).toEqual([[2, "retire"]]);
  expect(traffic.pendingBytes).toBe(64 * 1024);
  const released = pipe.release();
  expect(pipe.release()).toBe(released);
  await released;
  expect(requests.map(request => [request.sequence, request.operation.kind])).toEqual([[2, "retire"], [0xffff_ffff, "stop"]]);
  expect(traffic.pendingBytes).toBe(0);
});
function reply(request: InstallationRequest, result: InstallationReply["result"]): InstallationReply {
  return { ...identity, sequence: request.sequence, result };
}

it("keeps retirement supervision fenced when final release is uncertain", async () => {
  const traffic = new AssistanceTraffic(6);
  let releases = 0;
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    if (request.operation.kind === "retire") return Promise.resolve(reply(request, { kind: "retired" }));
    releases += 1;
    return Promise.reject(new Error("release receipt lost"));
  } };
  expect(() => installationStreams(agent, identity, 0xffff_fffe, traffic)).toThrow("sequence");
  const pipe = installationStreams(agent, identity, 0xffff_fffd, traffic);
  expect(() => pipe.process({ kind: "execute" })).toThrow("sequence exhausted");
  await pipe.retire();
  await expect(pipe.release()).rejects.toThrow("release receipt lost");
  await expect(pipe.release()).rejects.toThrow("release receipt lost");
  expect(releases).toBe(1);
  expect(traffic.pendingBytes).toBe(64 * 1024);
});

it("writes whole chunks and acknowledges exact completions before returning its window", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    const op = request.operation;
    return Promise.resolve(reply(request, op.kind === "write" ? { kind: "written", count: op.bytes.length }
      : op.kind === "read" ? { kind: "data", bytes: new Uint8Array([7]) }
      : op.kind === "stop" ? { kind: "stopped" } : { kind: "acknowledged" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const writer = pipe.output.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  const reader = pipe.input.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  await pipe.close();
  expect(operations.map(request => [request.sequence, request.operation.kind])).toEqual([
    [2, "write"], [2, "acknowledge"], [3, "read"], [3, "acknowledge"], [0xffff_ffff, "stop"],
  ]);
  expect(traffic.pendingBytes).toBe(0);
  reader.releaseLock(); writer.releaseLock();
});

it("stops the guest before awaiting a blocked read and acknowledges its cancellation", async () => {
  const traffic = new AssistanceTraffic(6);
  const reading = Promise.withResolvers<InstallationReply>();
  const started = Promise.withResolvers<InstallationRequest>();
  const agent = { async installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    if (request.operation.kind === "read") { started.resolve(request); return reading.promise; }
    if (request.operation.kind === "stop") {
      reading.resolve(reply(await started.promise, { kind: "error", errno: 125 }));
      return reply(request, { kind: "stopped" });
    }
    return reply(request, { kind: "acknowledged" });
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const reader = pipe.input.getReader();
  const read = reader.read();
  await started.promise;
  const closing = pipe.close();
  expect(pipe.close()).toBe(closing);
  await closing;
  await expect(read).resolves.toMatchObject({ done: true });
  expect(traffic.pendingBytes).toBe(0);
  reader.releaseLock();
});

it("keeps its window fenced when a write acknowledgement is uncertain", async () => {
  const traffic = new AssistanceTraffic(6);
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    if (request.operation.kind === "acknowledge") return Promise.reject(new Error("acknowledgement lost"));
    return Promise.resolve(reply(request, request.operation.kind === "stop" ? { kind: "stopped" } : { kind: "written", count: 1 }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const writer = pipe.output.getWriter();
  // Admission returns once the write is in flight; the lost acknowledgement
  // surfaces at the next write or at close and keeps the window fenced.
  await writer.write(new Uint8Array([1]));
  await expect(pipe.close()).rejects.toThrow("acknowledgement lost");
  await expect(writer.write(new Uint8Array([2]))).rejects.toThrow("acknowledgement lost");
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  writer.releaseLock();
});

it("shares installer and registry ordering while a blocked stdin retains its acknowledgement", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const blocked = Promise.withResolvers<InstallationReply>();
  let stdin: InstallationRequest | undefined;
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "stdin": stdin = request; return blocked.promise;
      case "execute": return Promise.resolve(reply(request, { kind: "spawned", child: 1, pid: 42 }));
      case "write": return Promise.resolve(reply(request, { kind: "written", count: request.operation.bytes.length }));
      case "signal": return Promise.resolve(reply(request, { kind: "unit" }));
      case "stop":
        if (stdin !== undefined) blocked.resolve(reply(stdin, { kind: "error", errno: 125 }));
        return Promise.resolve(reply(request, { kind: "stopped" }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "workspace-capture": case "workspace-capture-read": case "workspace-capture-retire": case "capture": case "capture-read": case "capture-retire": case "materialize": case "activate-materialized": case "retire": case "start": case "read": case "close-stdin": case "output-ack": throw new Error("Unexpected test operation");
    }
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  await pipe.process({ kind: "execute" });
  const writing = pipe.process({ kind: "stdin", child: 1, bytes: new Uint8Array([1]) });
  const writer = pipe.output.getWriter();
  await writer.write(new Uint8Array([2]));
  await pipe.process({ kind: "signal", child: 1, signal: 2 });
  await pipe.close();
  await expect(writing).resolves.toMatchObject({ result: { kind: "error", errno: 125 } });
  expect(operations.filter(request => request.operation.kind !== "acknowledge").map(request => request.sequence))
    .toEqual([2, 3, 4, 5, 0xffff_ffff]);
  expect(operations.at(-1)?.operation.kind).toBe("acknowledge");
  expect(() => pipe.process({ kind: "execute" })).toThrow("closed");
  expect(traffic.pendingBytes).toBe(0);
  writer.releaseLock();
});

it("cancels materialization before releasing its acknowledged supervision", async () => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const copying = Promise.withResolvers<InstallationReply>();
  const stopping = Promise.withResolvers<InstallationReply>();
  const started = Promise.withResolvers<undefined>();
  let copy: InstallationRequest | undefined;
  let stop: InstallationRequest | undefined;
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    if (request.operation.kind === "retire") return Promise.resolve(reply(request, { kind: "retired" }));
    if (request.operation.kind === "materialize") { copy = request; started.resolve(undefined); return copying.promise; }
    if (request.operation.kind === "stop") {
      stop = request;
      if (copy === undefined) throw new Error("missing materialization");
      copying.resolve(reply(copy, { kind: "error", errno: 125 }));
      return stopping.promise;
    }
    if (request.operation.kind === "acknowledge") {
      if (stop === undefined) throw new Error("missing Stop");
      stopping.resolve(reply(stop, { kind: "stopped" }));
      return Promise.resolve(reply(request, { kind: "acknowledged" }));
    }
    throw new Error("unexpected operation");
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  await pipe.retire();
  const work = pipe.materialize();
  expect(pipe.materialize()).toBe(work);
  const rejected = expect(work).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  expect(traffic.pendingBytes).toBe(64 * 1024);
  await pipe.release();
  await rejected;
  expect(requests.map(request => [request.sequence, request.operation.kind]))
    .toEqual([[2, "retire"], [3, "materialize"], [0xffff_ffff, "stop"], [3, "acknowledge"]]);
  expect(traffic.pendingBytes).toBe(0);
});

it.each([0, 5])("releases acknowledged materialization outcome %i independently of copy success", async errno => {
  const traffic = new AssistanceTraffic(6);
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "retire": return Promise.resolve(reply(request, { kind: "retired" }));
      case "materialize": return Promise.resolve(reply(request, errno === 0 ? { kind: "materialized" } : { kind: "error", errno }));
      case "activate-materialized": return Promise.resolve(reply(request, { kind: "unit" }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "stop": return Promise.resolve(reply(request, { kind: "stopped" }));
      case "workspace-capture": case "workspace-capture-read": case "workspace-capture-retire": case "capture": case "capture-read": case "capture-retire": case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "output-ack": throw new Error("unexpected operation");
    }
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  await pipe.retire();
  if (errno === 0) await pipe.materialize();
  else await expect(pipe.materialize()).rejects.toMatchObject({ code: "RELAY_ERROR" });
  expect(traffic.pendingBytes).toBe(64 * 1024);
  await pipe.release();
  expect(traffic.pendingBytes).toBe(0);
});

it.each([0, 5])("captures with independent acknowledged retirement outcome %i", async errno => {
  const traffic = new AssistanceTraffic(6);
  const operations: string[] = [];
  let reads = 0;
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request.operation.kind);
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "retire": return Promise.resolve(reply(request, { kind: "retired" }));
      case "materialize": return Promise.resolve(reply(request, { kind: "materialized" }));
      case "activate-materialized": return Promise.resolve(reply(request, { kind: "unit" }));
      case "capture": return Promise.resolve(reply(request, { kind: "capture-ready", bytes: 1 }));
      case "capture-read": return Promise.resolve(reply(request, { kind: "data", bytes: reads++ === 0 ? Uint8Array.of(7) : new Uint8Array() }));
      case "capture-retire": return Promise.resolve(reply(request, { kind: "capture-retired", errno }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "stop": return Promise.resolve(reply(request, { kind: "stopped" }));
      case "workspace-capture": case "workspace-capture-read": case "workspace-capture-retire": case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "output-ack": throw new Error("Unexpected capture test operation");
    }
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  await pipe.retire(); await pipe.materialize();
  const capture = await pipe.capture();
  expect(await pipe.capture()).toBe(capture);
  const producer = capture.source(new AbortController().signal);
  const frames = producer.frames[Symbol.asyncIterator]();
  expect((await frames.next()).value).toEqual(Uint8Array.of(7));
  if (errno === 0) expect((await frames.next()).done).toBe(true);
  else await expect(frames.next()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await producer.retire();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  await pipe.release();
  expect(traffic.pendingBytes).toBe(0);
  expect(operations.filter(operation => operation === "capture-retire")).toHaveLength(1);
});

it.each([0xffff_fffa, 0xffff_fffb])("reserves capture retirement and final stop at sequence %i", async initial => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "retire": return Promise.resolve(reply(request, { kind: "retired" }));
      case "materialize": return Promise.resolve(reply(request, { kind: "materialized" }));
      case "activate-materialized": return Promise.resolve(reply(request, { kind: "unit" }));
      case "capture": return Promise.resolve(reply(request, { kind: "capture-ready", bytes: 1 }));
      case "capture-retire": return Promise.resolve(reply(request, { kind: "capture-retired", errno: 125 }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "stop": return Promise.resolve(reply(request, { kind: "stopped" }));
      case "workspace-capture": case "workspace-capture-read": case "workspace-capture-retire": case "capture-read": case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "output-ack": throw new Error("Unexpected request after exhaustion");
    }
  } };
  const pipe = installationStreams(agent, identity, initial, traffic);
  await pipe.retire(); await pipe.materialize();
  if (initial === 0xffff_fffb) {
    await expect(pipe.capture()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await pipe.release();
    expect(requests.some(request => request.operation.kind === "capture")).toBe(false);
    expect(traffic.pendingBytes).toBe(0);
    return;
  }
  const input = await pipe.capture();
  const producer = input.source(new AbortController().signal);
  await expect(producer.frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await producer.retire(); await pipe.release();
  expect(requests.filter(request => request.operation.kind === "capture-retire" || request.operation.kind === "stop")
    .map(request => request.sequence)).toEqual([0xffff_fffe, 0xffff_ffff]);
  expect(traffic.pendingBytes).toBe(0);
});

it("captures all publication sources with separate retirement and one sequence owner", async () => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "retire": return Promise.resolve(reply(request, { kind: "retired" }));
      case "materialize": return Promise.resolve(reply(request, { kind: "materialized" }));
      case "activate-materialized": return Promise.resolve(reply(request, { kind: "unit" }));
      case "capture": case "workspace-capture": return Promise.resolve(reply(request, { kind: "capture-ready", bytes: 0 }));
      case "capture-read": case "workspace-capture-read": return Promise.resolve(reply(request, { kind: "data", bytes: new Uint8Array() }));
      case "capture-retire": case "workspace-capture-retire": return Promise.resolve(reply(request, { kind: "capture-retired", errno: 0 }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "stop": return Promise.resolve(reply(request, { kind: "stopped" }));
      case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "output-ack": throw new Error("Unexpected publication operation");
    }
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  await pipe.retire(); await pipe.materialize();
  const captures = await Promise.all([pipe.capture(), pipe.capture("snapshot"), pipe.capture("delta")]);
  expect(new Set(captures).size).toBe(3);
  expect(await pipe.capture("snapshot")).toBe(captures[1]);
  await Promise.all(captures.map(async capture => {
    const producer = capture.source(new AbortController().signal);
    expect((await producer.frames[Symbol.asyncIterator]().next()).done).toBe(true);
    await producer.retire();
  }));
  await pipe.release();
  expect(traffic.pendingBytes).toBe(0);
  expect(requests.filter(request => request.operation.kind === "workspace-capture-retire")
    .map(request => request.operation)).toEqual([
      { kind: "workspace-capture-retire", source: "snapshot" },
      { kind: "workspace-capture-retire", source: "delta" },
    ]);
  const sequences = requests.filter(request => request.operation.kind !== "acknowledge").map(request => request.sequence);
  expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b));
});

it("keeps a retirement sequence for each concurrent publication source", async () => {
  const traffic = new AssistanceTraffic(6);
  const requests: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    requests.push(request);
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "retire": return Promise.resolve(reply(request, { kind: "retired" }));
      case "materialize": return Promise.resolve(reply(request, { kind: "materialized" }));
      case "activate-materialized": return Promise.resolve(reply(request, { kind: "unit" }));
      case "capture": case "workspace-capture": return Promise.resolve(reply(request, { kind: "capture-ready", bytes: 1 }));
      case "capture-retire": case "workspace-capture-retire": return Promise.resolve(reply(request, { kind: "capture-retired", errno: 125 }));
      case "acknowledge": return Promise.resolve(reply(request, { kind: "acknowledged" }));
      case "stop": return Promise.resolve(reply(request, { kind: "stopped" }));
      case "start": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "execute": case "workspace-capture-read": case "output-ack": case "capture-read": throw new Error("Unexpected request after exhaustion");
    }
  } };
  const pipe = installationStreams(agent, identity, 0xffff_fff6, traffic);
  await pipe.retire(); await pipe.materialize();
  const inputs = await Promise.all([pipe.capture(), pipe.capture("snapshot"), pipe.capture("delta")]);
  for (const input of inputs) {
    const producer = input.source(new AbortController().signal);
    await expect(producer.frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  await pipe.release();
  expect(requests.filter(request => request.operation.kind === "capture-retire" || request.operation.kind === "workspace-capture-retire" || request.operation.kind === "stop")
    .map(request => request.sequence)).toEqual([0xffff_fffc, 0xffff_fffd, 0xffff_fffe, 0xffff_ffff]);
  expect(traffic.pendingBytes).toBe(0);
});

it("reports exchange round trips to its observer without changing ordering or windows", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const observed: { kind: string; bytes: number; requestMs: number; acknowledgeMs: number; failed: "request" | "acknowledge" | null }[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    const op = request.operation;
    return Promise.resolve(reply(request, op.kind === "write" ? { kind: "written", count: op.bytes.length }
      : op.kind === "read" ? { kind: "data", bytes: new Uint8Array([7, 8]) }
      : op.kind === "stop" ? { kind: "stopped" } : { kind: "acknowledged" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic, { observe: observation => { observed.push(observation); } });
  const writer = pipe.output.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  const reader = pipe.input.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([7, 8]));
  await pipe.close();
  expect(operations.map(request => [request.sequence, request.operation.kind])).toEqual([
    [2, "write"], [2, "acknowledge"], [3, "read"], [3, "acknowledge"], [0xffff_ffff, "stop"],
  ]);
  expect(observed.map(({ kind, bytes, failed }) => [kind, bytes, failed])).toEqual([["write", 3, null], ["read", 2, null]]);
  for (const observation of observed) {
    expect(Number.isFinite(observation.requestMs) && observation.requestMs >= 0).toBe(true);
    expect(Number.isFinite(observation.acknowledgeMs) && observation.acknowledgeMs >= 0).toBe(true);
  }
  expect(traffic.pendingBytes).toBe(0);
});

it("reports a refused acknowledgement to its observer as a failed exchange", async () => {
  const traffic = new AssistanceTraffic(6);
  const observed: { kind: string; failed: "request" | "acknowledge" | null; requestMs: number; acknowledgeMs: number }[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    const op = request.operation;
    if (op.kind === "acknowledge" && request.sequence === 2) {
      return Promise.reject(new VMError("STORAGE_ERROR", "Permission denied (os error 13)", { agentStatus: 4, agentKind: 19 }));
    }
    return Promise.resolve(reply(request, op.kind === "write" ? { kind: "written", count: op.bytes.length }
      : op.kind === "stop" ? { kind: "stopped" } : { kind: "acknowledged" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic, { observe: observation => { observed.push(observation); } });
  const writer = pipe.output.getWriter();
  await writer.write(new Uint8Array([1, 2, 3])).catch(() => undefined);
  await writer.close().catch(() => undefined);
  await pipe.close().catch(() => undefined);
  expect(observed.map(({ kind, failed }) => [kind, failed])).toEqual([["write", "acknowledge"]]);
  const [observation] = observed;
  expect(observation !== undefined && observation.requestMs >= 0 && observation.acknowledgeMs >= 0).toBe(true);
});

it("issues the next write before the previous acknowledgement and preserves sequence order", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const pendingWrites = new Map<number, (reply: InstallationReply) => void>();
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    const op = request.operation;
    if (op.kind === "write") return new Promise(resolve => { pendingWrites.set(request.sequence, resolve); });
    return Promise.resolve(reply(request, op.kind === "stop" ? { kind: "stopped" } : { kind: "acknowledged" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const writer = pipe.output.getWriter();
  const writes = [new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array([3, 3, 3]), new Uint8Array([4, 4, 4, 4]), new Uint8Array([5, 5, 5, 5, 5])];
  const admitted: Promise<void>[] = [];
  for (const bytes of writes) admitted.push(writer.write(bytes));
  await Promise.all(admitted.slice(0, 3));
  // The derived window (three writes beside the blocking read) is in flight
  // without any reply; the fourth waits for a slot.
  expect(operations.map(request => [request.sequence, request.operation.kind])).toEqual([[2, "write"], [3, "write"], [4, "write"]]);
  let fourthAdmitted = false;
  void admitted[3]?.then(() => { fourthAdmitted = true; });
  await Promise.resolve();
  expect(fourthAdmitted).toBe(false);
  pendingWrites.get(2)?.({ ...identity, sequence: 2, result: { kind: "written", count: 1 } });
  await admitted[3];
  expect(operations.map(request => [request.sequence, request.operation.kind])).toEqual([
    [2, "write"], [3, "write"], [4, "write"], [2, "acknowledge"], [5, "write"],
  ]);
  // Each completion returns one slot; the fifth write (sequence 6) follows the next one.
  pendingWrites.get(3)?.({ ...identity, sequence: 3, result: { kind: "written", count: 2 } });
  await admitted[4];
  for (const sequence of [4, 5, 6]) {
    const bytes = writes[sequence - 2];
    if (bytes === undefined) throw new Error("missing write");
    pendingWrites.get(sequence)?.({ ...identity, sequence, result: { kind: "written", count: bytes.length } });
  }
  await writer.close();
  await pipe.close();
  expect(operations.filter(request => request.operation.kind === "acknowledge").map(request => request.sequence)).toEqual([2, 3, 4, 5, 6]);
  expect(traffic.pendingBytes).toBe(0);
});

it("reports a short write completion as a protocol failure instead of re-issuing the remainder", async () => {
  const traffic = new AssistanceTraffic(6);
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    const op = request.operation;
    return Promise.resolve(reply(request, op.kind === "write" ? { kind: "written", count: 1 }
      : op.kind === "stop" ? { kind: "stopped" } : { kind: "acknowledged" }));
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const writer = pipe.output.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await expect(writer.write(new Uint8Array([4]))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(pipe.close()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  // An uncertain completion fences the window rather than returning it.
  expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("keeps every concurrent data exchange within the guest's installation lane", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const pendingReplies = new Map<number, (reply: InstallationReply) => void>();
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    const op = request.operation;
    if (op.kind === "acknowledge") return Promise.resolve(reply(request, { kind: "acknowledged" }));
    if (op.kind === "stop") return Promise.resolve(reply(request, { kind: "stopped" }));
    return new Promise(resolve => { pendingReplies.set(request.sequence, resolve); });
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const reader = pipe.input.getReader();
  const reading = reader.read();
  const writer = pipe.output.getWriter();
  const writes = [1, 2, 3, 4].map(value => writer.write(new Uint8Array([value])));
  for (const write of writes) void write.catch(() => {});
  const validating = pipe.process({ kind: "validate-inputs" });
  void validating.catch(() => {});
  const dataExchanges = () => operations.filter(request => request.operation.kind !== "acknowledge");
  for (let turn = 0; turn < 64 && dataExchanges().length < 5; turn += 1) await Promise.resolve();
  // One blocking read, the derived write window and one process operation are
  // the most control ever holds; the fourth write waits for the window.
  const inFlight = dataExchanges();
  expect(inFlight.map(request => request.operation.kind)).toEqual(["validate-inputs", "read", "write", "write", "write"]);
  expect(inFlight.length).toBeLessThanOrEqual(INSTALLATION_DATA_LANE);
  expect(3 * CAPTURE_READ_WINDOW).toBeLessThanOrEqual(CAPTURE_DATA_LANE);
  for (const request of inFlight) {
    const result: InstallationReply["result"] = request.operation.kind === "read" ? { kind: "data", bytes: new Uint8Array() }
      : request.operation.kind === "write" ? { kind: "written", count: 1 } : { kind: "data", bytes: new Uint8Array(64) };
    pendingReplies.get(request.sequence)?.(reply(request, result));
  }
  await Promise.all([reading, validating, ...writes.slice(0, 3)]);
  // The window returned by the first completion admits the fourth write.
  for (let turn = 0; turn < 64 && dataExchanges().length < 6; turn += 1) await Promise.resolve();
  const fourth = dataExchanges()[5];
  if (fourth === undefined || fourth.operation.kind !== "write") throw new Error("fourth write was not issued");
  pendingReplies.get(fourth.sequence)?.(reply(fourth, { kind: "written", count: 1 }));
  await writes[3];
  await writer.close();
  await pipe.close();
  expect(traffic.pendingBytes).toBe(0);
});
