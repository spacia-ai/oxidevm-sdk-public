import { expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createProcessKill } from "./node-process.js";

it("sends process signals through the authenticated Linux owner, including signal zero", () => {
  const send = vi.fn<(pid: number, signal: number) => void>();
  const kill = createProcessKill(send);
  expect(kill(42)).toBe(true);
  expect(kill(42, "SIGINT")).toBe(true);
  expect(kill(42, 0)).toBe(true);
  expect(kill(42, "SIGIOT")).toBe(true);
  expect(send.mock.calls).toEqual([[42, 15], [42, 2], [42, 0], [42, 6]]);
  for (const value of [1.5, NaN, Infinity, 2 ** 31, undefined]) {
    assert.throws(() => kill(value, 0), { code: "ERR_INVALID_ARG_TYPE" });
  }
  assert.throws(() => kill(42, "UNKNOWN"), { code: "ERR_UNKNOWN_SIGNAL" });
  const failure = Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
  send.mockImplementation(() => { throw failure; });
  expect(() => kill(99)).toThrow(failure);
  assert.throws(() => createProcessKill(undefined)(42), { code: "FEATURE_NOT_AVAILABLE" });
});
