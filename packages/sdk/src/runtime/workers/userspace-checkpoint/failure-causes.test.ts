import { expect, it } from "vitest";
import { decodeOwnerPath } from "./failure-causes.js";

it("retains the prepared exec image execution cause at the file-operation boundary", () => {
  expect(decodeOwnerPath("file-operation", 0x0206, 0, 0)).toEqual(["execution", "reference"]);
  expect(decodeOwnerPath("file-operation", 0x010606, 0, 0)).toEqual(["execution", "mapping", "state"]);
});

it("retains worker pool errors and rejects unknown worker variants", () => {
  expect(decodeOwnerPath("scheduler", 3, 0, 0)).toEqual(["worker-failure"]);
  expect(decodeOwnerPath("process", 19, 0, 0)).toEqual(["legacy-io-uring-workers-missing"]);
  expect(decodeOwnerPath("process", 21, 0, 0)).toEqual(["ambiguous-legacy-io-uring-cpu-group"]);
  expect(() => decodeOwnerPath("process", 22, 0, 0)).toThrow(/failure frame/u);
  expect(decodeOwnerPath("process", 0x0214, 0, 0)).toEqual(["io-uring-workers", "invalid-reference"]);
  expect(decodeOwnerPath("event", 0x0304, 0, 0)).toEqual(["io-uring-workers", "poisoned"]);
  expect(decodeOwnerPath("process", 0x020414, 0, 0)).toEqual(["io-uring-workers", "cgroup", "invalid-reference"]);
  for (const code of [0x0514, 0x14, 0x010014]) {
    expect(() => decodeOwnerPath("process", code, 0, 0)).toThrow(/failure frame/u);
  }
});

it("retains a five-level native CPU mode cause with its architectural register", () => {
  expect(decodeOwnerPath("files", 0x060e0409, 3, 3)).toEqual([
    "proc", "process", "cpu", "invalid-mode-transition", "reserved-control-register", "CR4",
  ]);
  expect(decodeOwnerPath("files", 0x010609, 0, 0)).toEqual(["proc", "memory", "bounds"]);
  expect(decodeOwnerPath("clock-read", 1, 0, 5)).toEqual(["errno", "io"]);
  expect(decodeOwnerPath("execution", 0x0204, 0, 9)).toEqual(["machine", "unsupported-version"]);
});

it("rejects future tags, zero holes, missing children and unused scalar words", () => {
  for (const [owner, low, high, scalar] of [
    ["workspace", 4, 0, 0], ["files", 0x010009, 0, 0], ["files", 9, 0, 0],
    ["workspace", 1, 1, 0], ["workspace", 1, 0, 1], ["clock-read", 1, 0, 0],
    ["cpu", 5, 0, 26], ["mode", 3, 0, 5], ["machine", 2, 0, 65536],
  ] as const) expect(() => decodeOwnerPath(owner, low, high, scalar)).toThrow(/failure frame/u);
});

it("retains Netlink allocation failures under API116 and rejects unknown leaves", () => {
  expect(decodeOwnerPath("files", 0x0711, 0, 0)).toEqual(["netlink", "accounting"]);
  expect(() => decodeOwnerPath("files", 0x0811, 0, 0)).toThrow(/failure frame/u);
});
