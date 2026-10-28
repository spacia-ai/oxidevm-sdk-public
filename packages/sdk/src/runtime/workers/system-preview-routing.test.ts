import { describe, expect, it } from "vitest";

import type { PreviewRuntimeCompletion, PreviewRuntimeOperation } from "./preview-runtime-channel.js";
import { ROUTING_PROCESS, SystemPreviewRouting, type AssistedPreview, type RouterTransport } from "./system-preview-routing.js";

/** A transport that answers from a script and records what it was asked. */
class ScriptedTransport {
  readonly operations: PreviewRuntimeOperation[] = [];
  readonly #answers: ((operation: PreviewRuntimeOperation) => PreviewRuntimeCompletion)[];

  constructor(...answers: ((operation: PreviewRuntimeOperation) => PreviewRuntimeCompletion)[]) {
    this.#answers = answers;
  }

  request(operation: PreviewRuntimeOperation): Promise<PreviewRuntimeCompletion> {
    this.operations.push(operation);
    const answer = this.#answers.shift();
    if (answer === undefined) throw new Error(`unexpected ${operation.kind}`);
    return Promise.resolve(answer(operation));
  }
}

function router(available: boolean, ...answers: ((operation: PreviewRuntimeOperation) => PreviewRuntimeCompletion)[]): RouterTransport & ScriptedTransport {
  return Object.assign(new ScriptedTransport(...answers), { available });
}

function assisted(holders: ReadonlyMap<number, number>, ...answers: ((operation: PreviewRuntimeOperation) => PreviewRuntimeCompletion)[]): AssistedPreview & ScriptedTransport {
  return Object.assign(new ScriptedTransport(...answers), { holder: (port: number) => holders.get(port) });
}

const opened = (process: number, connection: number) => (): PreviewRuntimeCompletion => ({ kind: "opened", generation: 1n, process, connection });
const listener = (): PreviewRuntimeCompletion => ({ kind: "error", code: "listener" });
const written = (): PreviewRuntimeCompletion => ({ kind: "written", bytes: 3 });
const closed = (): PreviewRuntimeCompletion => ({ kind: "closed" });

async function open(routing: SystemPreviewRouting): Promise<{ readonly generation: bigint; readonly process: number; readonly connection: number }> {
  const completion = await routing.request({ kind: "open", port: 3000, process: null });
  if (completion.kind !== "opened") throw new Error(`open answered ${completion.kind}`);
  return { generation: completion.generation, process: completion.process, connection: completion.connection };
}

describe("System preview routing", () => {
  it("keeps the assisted transport for a port an assisted task holds at open time", async () => {
    const link = router(true);
    const tasks = assisted(new Map([[3000, 41]]), opened(41, 5), written, closed);
    const routing = new SystemPreviewRouting(link, () => tasks);
    const target = await open(routing);
    expect(target.process).toBe(ROUTING_PROCESS);
    await expect(routing.request({ kind: "write", ...target, bytes: Uint8Array.of(1, 2, 3) })).resolves.toEqual({ kind: "written", bytes: 3 });
    await expect(routing.request({ kind: "close", ...target })).resolves.toEqual({ kind: "closed" });
    expect(tasks.operations).toEqual([
      { kind: "open", port: 3000, process: 41 },
      { kind: "write", generation: 1n, process: 41, connection: 5, bytes: Uint8Array.of(1, 2, 3) },
      { kind: "close", generation: 1n, process: 41, connection: 5 },
    ]);
    expect(link.operations).toEqual([]);
  });

  it("carries a session and its later operations through the router otherwise", async () => {
    const link = router(true, opened(1, 9), written, closed);
    const tasks = assisted(new Map());
    const routing = new SystemPreviewRouting(link, () => tasks);
    const target = await open(routing);
    await routing.request({ kind: "write", ...target, bytes: Uint8Array.of(7) });
    await routing.request({ kind: "close", ...target });
    expect(link.operations).toEqual([
      { kind: "open", port: 3000, process: null },
      { kind: "write", generation: 1n, process: 1, connection: 9, bytes: Uint8Array.of(7) },
      { kind: "close", generation: 1n, process: 1, connection: 9 },
    ]);
    expect(tasks.operations).toEqual([]);
  });

  it("waits for an assisted listener after the router finds none, when assistance is configured", async () => {
    const link = router(true, listener);
    const tasks = assisted(new Map(), opened(52, 3));
    const routing = new SystemPreviewRouting(link, () => tasks);
    await open(routing);
    expect(tasks.operations).toEqual([{ kind: "open", port: 3000, process: null }]);
  });

  it("answers a missing listener when the router finds none and nothing is assisted", async () => {
    const routing = new SystemPreviewRouting(router(true, listener), () => undefined);
    await expect(routing.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "listener" });
  });

  it("keeps today's assisted path without the link", async () => {
    const link = router(false);
    const tasks = assisted(new Map(), opened(52, 3));
    const routing = new SystemPreviewRouting(link, () => tasks);
    await open(routing);
    expect(tasks.operations).toEqual([{ kind: "open", port: 3000, process: null }]);
    expect(link.operations).toEqual([]);
  });

  it("answers process for an unknown or closed handle, and channel with no transport at all", async () => {
    const routing = new SystemPreviewRouting(router(true, opened(1, 9), closed), () => undefined);
    await expect(routing.request({ kind: "read", generation: 1n, process: ROUTING_PROCESS, connection: 77, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    const target = await open(routing);
    await expect(routing.request({ kind: "read", generation: 1n, process: 2, connection: target.connection, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    await routing.request({ kind: "close", ...target });
    await expect(routing.request({ kind: "read", ...target, maxBytes: 16 })).resolves.toEqual({ kind: "error", code: "process" });
    const nothing = new SystemPreviewRouting(router(false), () => undefined);
    await expect(nothing.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "channel" });
  });

  it("closes a connection past 128 open handles and answers staging", async () => {
    const answers = Array.from({ length: 129 }, (_, index) => opened(1, index + 1));
    const link = router(true, ...answers, closed);
    const routing = new SystemPreviewRouting(link, () => undefined);
    for (let index = 0; index < 128; index += 1) await open(routing);
    await expect(routing.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "staging" });
    expect(link.operations.at(-1)).toEqual({ kind: "close", generation: 1n, process: 1, connection: 129 });
  });
});
