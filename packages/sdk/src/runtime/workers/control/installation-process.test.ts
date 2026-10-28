import { expect, it, vi } from "vitest";
import { InstallationProcess } from "./installation-process.js";
import { AssistanceTraffic } from "./assistance-traffic.js";
import { installationStreams } from "./installation-stream.js";
import type { InstallationRequest } from "../../protocol/assistance-installation.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";
import type { InstallationEvent } from "../../protocol/assistance-installation-event.js";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1 };

it("bounds termination waiting without manufacturing an exit or releasing producer credit", async () => {
  vi.useFakeTimers();
  const traffic = new AssistanceTraffic(6);
  const process = new InstallationProcess(identity, operation => Promise.resolve({ ...identity, sequence: 1,
    result: operation.kind === "execute" ? { kind: "spawned", child: 1, pid: 42 } : { kind: "unit" },
  }), traffic, () => Promise.resolve(), error => { throw error; });
  try {
    await process.start();
    let exited = false;
    void process.exit.then(() => { exited = true; }, () => {});
    const terminated = expect(process.terminate()).rejects.toMatchObject({ code: "GUEST_CRASH" });
    await vi.advanceTimersByTimeAsync(30_000);
    await terminated;
    expect(exited).toBe(false);
    expect(traffic.pendingBytes).toBeGreaterThan(0);
    process.receive({ ...identity, sequence: 1, event: { kind: "exit", child: 1, code: 37, signal: null } });
    await expect(process.exit).resolves.toEqual({ code: 37 });
    process.retire();
    expect(traffic.pendingBytes).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("finishes preparation when exit arrives while kill waits for startup", async () => {
  const traffic = new AssistanceTraffic(6);
  const startup = Promise.withResolvers<InstallationReply>();
  let stopped = false;
  const process = new InstallationProcess(identity, operation => {
    expect(operation.kind).toBe("execute");
    return startup.promise;
  }, traffic, () => { stopped = true; return Promise.resolve(); }, error => { throw error; });
  const starting = process.start();
  const killing = process.kill();
  process.receive({ ...identity, sequence: 1, event: { kind: "exit", child: 1, code: 37, signal: null } });
  startup.resolve({ ...identity, sequence: 1, result: { kind: "spawned", child: 1, pid: 42 } });
  await starting;
  await expect(killing).resolves.toBeUndefined();
  expect(stopped).toBe(true);
  await expect(process.exit).resolves.toEqual({ code: 37 });
  process.retire();
  expect(traffic.pendingBytes).toBe(0);
});

it("retains slow output, preserves actual exit and retires the installer window separately", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    return Promise.resolve({ ...identity, sequence: request.sequence, result:
      request.operation.kind === "execute" ? { kind: "spawned", child: 1, pid: 42 }
      : request.operation.kind === "acknowledge" ? { kind: "acknowledged" }
      : request.operation.kind === "stop" ? { kind: "stopped" }
      : request.operation.kind === "stdin" ? { kind: "written", count: request.operation.bytes.length }
      : { kind: "unit" } });
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const process = new InstallationProcess(identity, pipe.process, traffic, () => pipe.close(), error => { throw error; });
  const starting = process.start();
  const receive = (sequence: number, event: InstallationEvent["event"]) => process.receive({ ...identity, sequence, event });
  receive(1, { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array([7]) });
  receive(2, { kind: "exit", child: 1, code: 37, signal: null });
  receive(3, { kind: "eof", child: 1, stream: "stdout" });
  receive(4, { kind: "eof", child: 1, stream: "stderr" });
  await starting;
  await expect(process.exit).resolves.toEqual({ code: 37 });
  expect(operations.some(request => request.operation.kind === "output-ack")).toBe(false);
  const reader = process.stdout.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  expect((await reader.read()).done).toBe(true);
  expect(operations.find(request => request.operation.kind === "output-ack")?.operation)
    .toEqual({ kind: "output-ack", child: 1, stream: "stdout", sequence: 1, bytes: 1 });
  await process.kill();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  process.retire();
  expect(traffic.pendingBytes).toBe(0);
  await expect(process.exit).resolves.toEqual({ code: 37 });
  reader.releaseLock();
});

it("drains cancelled output and fences replay without releasing unretired producer credit", async () => {
  const traffic = new AssistanceTraffic(6);
  const operations: InstallationRequest[] = [];
  const failures: unknown[] = [];
  const agent = { installation(_id: number, request: InstallationRequest): Promise<InstallationReply> {
    operations.push(request);
    return Promise.resolve({ ...identity, sequence: request.sequence, result:
      request.operation.kind === "execute" ? { kind: "spawned", child: 1, pid: 42 }
      : request.operation.kind === "acknowledge" ? { kind: "acknowledged" }
      : request.operation.kind === "stop" ? { kind: "stopped" } : { kind: "unit" } });
  } };
  const pipe = installationStreams(agent, identity, 1, traffic);
  const process = new InstallationProcess(identity, pipe.process, traffic, () => pipe.close(), error => { failures.push(error); });
  await process.start();
  const reader = process.stdout.getReader();
  const read = reader.read();
  await reader.cancel();
  await expect(read).resolves.toMatchObject({ done: true });
  const output: InstallationEvent = { ...identity, sequence: 1,
    event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array([9]) } };
  process.receive(output);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(operations.some(request => request.operation.kind === "output-ack")).toBe(true);
  expect(() => process.receive(output)).toThrow("identity");
  await expect(process.exit).rejects.toThrow("identity");
  expect(failures).toHaveLength(1);
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  await pipe.close();
  expect(traffic.pendingBytes).toBe(512 * 1024);
  process.retire(); process.retire();
  expect(traffic.pendingBytes).toBe(0);
  reader.releaseLock();
});

it("waits for EOF and acknowledged output before preparation can retire the process", async () => {
  const traffic = new AssistanceTraffic(7);
  const acknowledged = Promise.withResolvers<InstallationReply>();
  const process = new InstallationProcess(identity, operation => operation.kind === "output-ack" ? acknowledged.promise
    : Promise.resolve({ ...identity, sequence: 1, result: { kind: "spawned", child: 1, pid: 42 } }),
  traffic, () => Promise.resolve(), error => { throw error; });
  await process.start();
  process.receive({ ...identity, sequence: 1, event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array([7]) } });
  process.receive({ ...identity, sequence: 2, event: { kind: "exit", child: 1, code: 0, signal: null } });
  await expect(process.exit).resolves.toEqual({ code: 0 });
  let drained = false;
  void process.outputDrained.then(() => { drained = true; });
  const reader = process.stdout.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  process.receive({ ...identity, sequence: 3, event: { kind: "eof", child: 1, stream: "stdout" } });
  process.receive({ ...identity, sequence: 4, event: { kind: "eof", child: 1, stream: "stderr" } });
  await Promise.resolve();
  expect(drained).toBe(false);
  acknowledged.resolve({ ...identity, sequence: 2, result: { kind: "unit" } });
  await process.outputDrained;
  expect(drained).toBe(true);
  process.retire();
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(await process.stderr.getReader().read()).toEqual({ done: true, value: undefined });
  expect(traffic.pendingBytes).toBe(0);
});
