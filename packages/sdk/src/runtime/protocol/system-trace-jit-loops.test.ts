import { expect, it } from "vitest";
import { decodeJitLoopPolicy, decodeJitLoopStats } from "./system-trace-jit-loops.js";

it("validates loop policy bounds and exact source-read recurrence", () => {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true); bytes.set([1, 10, 4, 0, 1, 0], 4);
  for (let index = 0; index < 4; index++) view.setUint16(12 + index * 2, index, true);
  bytes.set([0, 0, 1, 8], 20); view.setBigUint64(32, 8n, true);
  expect(decodeJitLoopPolicy(bytes, 4)).toMatchObject({
    enabled: true, decision: "selected", nodes: [0, 1, 2, 3],
    reads: [{ instructionIndex: 0, sourceIndex: 1, width: 8, headerBias: 0n, stride: 8n }],
  });
  for (const [offset, value] of [[5, 11], [6, 33], [10, 1], [12, 4], [23, 3]] as const) {
    const invalid = bytes.slice(); invalid[offset] = value;
    expect(() => decodeJitLoopPolicy(invalid, 4)).toThrow();
  }
  expect(() => decodeJitLoopPolicy(bytes.subarray(0, 39), 4)).toThrow();
});

it("reads archived counters and rejects inconsistent or incomplete records", () => {
  const stats = decodeJitLoopStats({ chunks: 1n, backedges: 4n, retired: 18n,
    guards: { mode: 0n, cpl: 0n, shadow: 0n, alignment: 0n, budget: 0n, wrap: 0n, page: 0n, tag: 0n, epoch: 0n, ram: 0n, window: 0n },
    exits: { branch: 1n, budget: 0n, window: 0n } });
  expect(stats).toMatchObject({ chunks: 1n, backedges: 4n, retired: 18n, exits: { branch: 1n } });
  expect(decodeJitLoopStats(stats)).toEqual(stats);
  expect(() => decodeJitLoopStats({ ...stats, chunks: 2n })).toThrow();
  expect(() => decodeJitLoopStats({ ...stats, guards: {} })).toThrow();
});
