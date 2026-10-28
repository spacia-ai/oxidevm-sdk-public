import { expect, it } from "vitest";
import { decodeProcessControl } from "./process-control.js";

it("admits exact named signal and bounded PTY controls", () => {
  expect(decodeProcessControl({ kind: "signal", signal: "SIGWINCH", scope: "process-group" })).toEqual({ kind: "signal", signal: "SIGWINCH", scope: "process-group" });
  expect(decodeProcessControl({ kind: "resize", columns: 120, rows: 40 })).toEqual({ kind: "resize", columns: 120, rows: 40 });
  expect(decodeProcessControl({ kind: "interrupt" })).toEqual({ kind: "interrupt" });
  for (const input of [{ kind: "resize", columns: 0, rows: 24 }, { kind: "resize", columns: 1001, rows: 24 }, { kind: "signal", signal: "SIGTERM", scope: "all" }, { kind: "interrupt", leaked: true }]) {
    expect(() => decodeProcessControl(input)).toThrow();
  }
});
