import { expect, it } from "vitest";
import { UserspaceCold } from "./cold.js";

it("cold publication calls the shared invalidation boundary and ends only after native acceptance", () => {
  const calls: string[] = [];
  const raw = { ok(name: string) { calls.push(name); }, stage() {}, u64() { return 1n; }, frame() { return new Uint8Array(); } };
  const candidate = new UserspaceCold(raw, 9n, () => calls.push("ended"), () => calls.push("invalidate"));
  candidate.complete();
  expect(calls).toEqual(["invalidate", "cold_complete", "ended"]);
  expect(() => candidate.beginReconcile("saved")).toThrow();
});

it("a refused cold publication can only be discarded, never resumed as the previous runtime", () => {
  const calls: string[] = [];
  const raw = { ok(name: string) { calls.push(name); if (name === "cold_complete") throw new Error("uncommitted files"); },
    stage() {}, u64() { return 1n; }, frame() { return new Uint8Array(); } };
  const candidate = new UserspaceCold(raw, 9n, () => calls.push("ended"), () => {});
  expect(() => candidate.complete()).toThrow("uncommitted files");
  candidate.abort(); candidate.abort();
  expect(calls).toEqual(["cold_complete", "cold_abort", "ended"]);
  expect(() => candidate.exportWorkspace()).toThrow();
});
