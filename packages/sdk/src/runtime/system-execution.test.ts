import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { SystemExecutionTransport } from "./system-execution.js";

describe("continuous system execution transport", () => {
  it("acknowledges console only when the stream consumer pulls it", async () => {
    const channel = new MessageChannel();
    const acknowledgements: unknown[] = [];
    channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      acknowledgements.push(event.data);
    });
    channel.port2.start();
    const execution = new SystemExecutionTransport(channel.port1, 7, {
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    const reader = execution.events.getReader();

    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 7,
      sequence: 1,
      type: "console",
      data: new Uint8Array([35, 32]),
    });
    await nextTask();
    expect(acknowledgements).toEqual([]);

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { kind: "console", data: new Uint8Array([35, 32]) },
    });
    await nextTask();
    expect(acknowledgements).toEqual([
      {
        version: PROTOCOL_VERSION,
        sessionId: 7,
        type: "console-ack",
        sequence: 1,
      },
    ]);

    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 7,
      sequence: 2,
      type: "exit",
      exit: { kind: "halted", steps: 12n },
    });
    await expect(execution.exit).resolves.toEqual({
      kind: "halted",
      steps: 12n,
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    channel.port2.close();
  });

  it("fails closed on the first missing or duplicate sequence", async () => {
    const channel = new MessageChannel();
    const execution = new SystemExecutionTransport(channel.port1, 9, {
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 9,
      sequence: 2,
      type: "exit",
      exit: { kind: "halted", steps: 1n },
    });
    await expect(execution.exit).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
    channel.port2.close();
  });

  it("coalesces control calls and makes stop idempotent", async () => {
    const channel = new MessageChannel();
    let pauses = 0;
    let resumes = 0;
    let stops = 0;
    const execution = new SystemExecutionTransport(channel.port1, 3, {
      pause: () => {
        pauses += 1;
        return Promise.resolve();
      },
      resume: () => {
        resumes += 1;
        return Promise.resolve();
      },
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    });
    await execution.pause();
    await execution.resume();
    const first = execution.stop();
    const second = execution.stop();
    await Promise.all([first, second]);
    await execution.pause();
    await execution.resume();
    expect({ pauses, resumes, stops }).toEqual({
      pauses: 1,
      resumes: 1,
      stops: 1,
    });
    execution.fail(new VMError("ABORTED", "test complete"));
    await expect(execution.exit).rejects.toMatchObject({
      code: "ABORTED",
    });
    channel.port2.close();
  });

  it("does not send a redundant stop after a terminal worker error", async () => {
    const channel = new MessageChannel();
    let stops = 0;
    const execution = new SystemExecutionTransport(channel.port1, 11, {
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    });
    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 11,
      sequence: 1,
      type: "error",
      error: { code: "VM_FAULT", message: "guest failed" },
    });

    await expect(execution.exit).rejects.toMatchObject({
      code: "VM_FAULT",
    });
    expect(stops).toBe(0);
    channel.port2.close();
  });
});

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
