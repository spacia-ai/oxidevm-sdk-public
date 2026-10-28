import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemSessions, type SystemSessionDriver } from "./system-session.js";
import { AgentRequests } from "./agent-requests.js";
import { AGENT_RESPONSE_BIT, AgentKind } from "../../agent-protocol.js";
import { SystemExecutionTransport } from "../../system-execution.js";

describe("system session scheduling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drains retained console chunks before reporting natural termination", async () => {
    const channel = new MessageChannel();
    const chunks = [new Uint8Array([65]), new Uint8Array([66])];
    const driver: SystemSessionDriver = {
      run: () => Promise.resolve({ kind: "halted", steps: 1n }),
      readConsole: () => chunks.shift() ?? new Uint8Array(),
      telemetry: () => ({ profile: "x86-64-v3", jitState: "active", retiredInstructions: 1n,
        jitInstructions: 0n, interpretedInstructions: 1n, cacheHits: 0n, moduleLoads: 0n,
        compileSamples: 0, compileP95Milliseconds: 0, compileMaximumMilliseconds: 0,
        guardExits: 0n, evictions: 0n, cacheEntries: 0, cacheBytes: 0, cacheLimitBytes: 1 }),
      pause: () => Promise.resolve(), invalidate: vi.fn(), stopped: vi.fn(),
      yield: () => Promise.resolve(), recordYield: vi.fn(),
    };
    const sessions = new SystemSessions(driver);
    const execution = new SystemExecutionTransport(channel.port2, 1, {
      pause: () => sessions.control(1, "pause"), resume: () => sessions.control(1, "resume"),
      stop: () => sessions.stop(1),
    });
    try {
      sessions.start(1, channel.port1, new Uint8Array([35]));
      const reader = execution.events.getReader();
      const bytes: number[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.kind === "console") bytes.push(...part.value.data);
      }
      expect(bytes).toEqual([35, 65, 66]);
      await expect(execution.exit).resolves.toMatchObject({ kind: "halted" });
    } finally {
      sessions.fail(new Error("test cleanup"));
      channel.port1.close(); channel.port2.close();
    }
  });

  it("reports where its pump waits so a stalled guest can be told from a stalled scheduler", async () => {
    const channel = new MessageChannel();
    let releaseRun: ((exit: { kind: "step-limit"; steps: bigint }) => void) | undefined;
    let releaseYield: (() => void) | undefined;
    const telemetry = () => ({ profile: "x86-64-v3" as const, jitState: "active" as const, retiredInstructions: 1n,
      jitInstructions: 0n, interpretedInstructions: 1n, cacheHits: 0n, moduleLoads: 0n,
      compileSamples: 0, compileP95Milliseconds: 0, compileMaximumMilliseconds: 0,
      guardExits: 0n, evictions: 0n, cacheEntries: 0, cacheBytes: 0, cacheLimitBytes: 1 });
    const driver: SystemSessionDriver = {
      run: () => new Promise(resolve => { releaseRun = resolve; }),
      readConsole: () => new Uint8Array(),
      telemetry,
      pause: () => Promise.resolve(), invalidate: vi.fn(), stopped: vi.fn(),
      yield: () => new Promise<void>(resolve => { releaseYield = resolve; }), recordYield: vi.fn(),
    };
    const sessions = new SystemSessions(driver);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      expect(sessions.diagnostics()).toEqual({ active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" });
      sessions.start(1, channel.port1, new Uint8Array());
      await settle();
      // The initial yield precedes the first slice.
      expect(sessions.diagnostics()).toMatchObject({ active: true, waiting: "yield-task" });
      releaseYield?.(); await settle();
      expect(sessions.diagnostics()).toMatchObject({ waiting: "run" });
      releaseRun?.({ kind: "step-limit", steps: 0n }); await settle();
      expect(sessions.diagnostics()).toMatchObject({ waiting: "yield-idle" });
      releaseYield?.(); await settle();
      releaseRun?.({ kind: "step-limit", steps: 5n }); await settle();
      expect(sessions.diagnostics()).toMatchObject({ waiting: "yield-task" });
      const pausing = sessions.control(1, "pause");
      releaseYield?.(); await pausing; await settle();
      expect(sessions.diagnostics()).toMatchObject({ paused: true, waiting: "paused" });
    } finally {
      sessions.fail(new Error("test cleanup"));
      channel.port1.close(); channel.port2.close();
    }
    expect(sessions.diagnostics()).toMatchObject({ active: false, waiting: "none" });
  });

  it("does not charge a replacement core for a failed session's delayed yield", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const channel = new MessageChannel();
    let resume: (() => void) | undefined;
    const recordYield = vi.fn();
    const stopped = vi.fn();
    const driver: SystemSessionDriver = {
      run: () => Promise.resolve({ kind: "step-limit", steps: 1n }),
      readConsole: () => new Uint8Array(),
      telemetry: () => { throw new Error("unexpected telemetry"); },
      pause: () => Promise.resolve(), invalidate: vi.fn(), stopped,
      yield: () => new Promise<void>(resolve => { resume = resolve; }),
      recordYield,
    };
    const sessions = new SystemSessions(driver);
    try {
      sessions.start(1, channel.port1, new Uint8Array());
      resume?.();
      await Promise.resolve();
      await Promise.resolve();
      sessions.fail(new Error("core replaced"));
      resume?.();
      await Promise.resolve();
      expect(recordYield).not.toHaveBeenCalled();
      expect(stopped).toHaveBeenCalledTimes(1);
    } finally {
      sessions.fail(new Error("test cleanup"));
      resume?.();
      channel.port1.close(); channel.port2.close();
    }
  });

  it("keeps the private agent and cancellation live behind unacknowledged console output", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const channel = new MessageChannel();
    const requests = new AgentRequests();
    const read = requests.open(AgentKind.readFile, 1);
    const blocked = requests.open(AgentKind.readFile, 2);
    const completion = requests.wait(read, 1000);
    const cancelled = expect(requests.wait(blocked, 1000)).rejects.toMatchObject({ code: "ABORTED" });
    let slices = 0;
    let wake: (() => void) | undefined;
    const consoleRead = vi.fn(() => new Uint8Array([65]));
    const onStopped = vi.fn();
    const driver: SystemSessionDriver = {
      run: () => {
        slices += 1;
        requests.receive({ version: 4, requestId: read.id, kind: AgentKind.readFile | AGENT_RESPONSE_BIT, status: 0, payload: new Uint8Array([9]) });
        requests.cancelWorker(2);
        return Promise.resolve({ kind: "step-limit", steps: 1n });
      },
      readConsole: consoleRead,
      telemetry: () => { throw new Error("unexpected telemetry"); },
      pause: () => Promise.resolve(),
      invalidate: vi.fn(),
      stopped: onStopped,
      yield: () => new Promise<void>(resolve => { wake = resolve; }),
      recordYield: vi.fn(),
    };
    const sessions = new SystemSessions(driver);
    try {
      sessions.start(1, channel.port1, new Uint8Array([35]));
      wake?.();
      await Promise.all([
        expect(completion).resolves.toMatchObject({ payload: new Uint8Array([9]) }),
        cancelled,
      ]);
      expect(slices).toBe(1);
      expect(consoleRead).not.toHaveBeenCalled();
      const stopped = sessions.stop();
      wake?.();
      await stopped;
      expect(onStopped).toHaveBeenCalledTimes(1);
      await sessions.stop();
      expect(sessions.active).toBeUndefined();
    } finally {
      sessions.fail(new Error("test cleanup"));
      wake?.();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
