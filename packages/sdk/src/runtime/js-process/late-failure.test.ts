import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import { decodeAccelerationNotice, decodeLateFailure, decodeLateFailureNotice, encodeAccelerationNotice, encodeLateFailureReport, lateFailureOf, lateFailureReporter, lateFailureSentence, lateFailureDetail } from "./late-failure.js";

it("reads only the fast-path limitations an error names in its structured detail", () => {
  expect(lateFailureOf(new VMError("FEATURE_NOT_AVAILABLE", "builtin is not supported", { lateFailure: "unavailable-builtin", subject: "node:sqlite" }))).toEqual({ kind: "unavailable-builtin", detail: "node:sqlite" });
  expect(lateFailureOf(new VMError("PROTOCOL_ERROR", "Unqualified native addon: /x/a.node", { lateFailure: "unqualified-addon", subject: "a.node" }))).toEqual({ kind: "unqualified-addon", detail: "a.node" });
  for (const error of [new Error("boom"), new VMError("FEATURE_NOT_AVAILABLE", "x"), new VMError("FEATURE_NOT_AVAILABLE", "x", { lateFailure: "other", subject: "y" }),
    new VMError("FEATURE_NOT_AVAILABLE", "x", { lateFailure: "unavailable-builtin", subject: 3 }), "text", undefined]) {
    expect(lateFailureOf(error)).toBeUndefined();
  }
  expect(lateFailureOf(new VMError("FEATURE_NOT_AVAILABLE", "x", { lateFailure: "unsupported-node-api", subject: "napi_x\nsecret" }))).toEqual({ kind: "unsupported-node-api", detail: "napi_xsecret" });
  expect(lateFailureDetail("é".repeat(300)).length).toBeLessThanOrEqual(255);
});

it("encodes the command report Rust validates and decodes its notice exactly", () => {
  const report = encodeLateFailureReport({ generation: 7n, id: 9n }, { kind: "unavailable-builtin", detail: "node:sqlite" });
  const view = new DataView(report.buffer);
  expect(view.getUint32(0, true)).toBe(1);
  expect(report[4]).toBe(5);
  expect(view.getBigUint64(5, true)).toBe(7n);
  expect(view.getBigUint64(13, true)).toBe(9n);
  expect(Array.from(report.subarray(21, 23))).toEqual([1, 11]);
  expect(new TextDecoder().decode(report.subarray(23))).toBe("node:sqlite");
  const record = new Uint8Array([79, 88, 65, 75, 1, 0, 0, 0, 0, 0, 0, 0]);
  const notice = new Uint8Array(16 + record.length); notice.set(new TextEncoder().encode("OXAF"));
  const writer = new DataView(notice.buffer); writer.setUint32(4, 1, true); writer.setUint32(8, 42, true); writer.setUint32(12, 40, true); notice.set(record, 16);
  expect(decodeLateFailureNotice(notice)).toEqual({ pid: 42, session: 40, record });
  for (const bad of [notice.subarray(0, 15), new Uint8Array([...notice.subarray(0, 4), 2, 0, 0, 0, ...notice.subarray(8)]), new Uint8Array([88, ...notice.subarray(1)]), notice.subarray(0, 16)]) {
    expect(() => decodeLateFailureNotice(bad)).toThrow();
  }
});

it("explains a late failure in one plain sentence", () => {
  expect(lateFailureSentence({ kind: "unavailable-builtin", detail: "node:sqlite" })).toBe("This program uses node:sqlite, which the fast path does not provide; its next run uses full Linux.");
  expect(lateFailureSentence({ kind: "unqualified-addon", detail: "sharp.node" })).toBe("This program loaded the add-on sharp.node, which the fast path cannot vouch for; its next run uses full Linux.");
  expect(lateFailureSentence({ kind: "unsupported-node-api", detail: "napi_run_script" })).toBe("This program's add-on called napi_run_script, which the fast path does not provide yet; its next run uses full Linux.");
  expect(lateFailureSentence({ kind: "eval-worker", detail: "" })).toBe("This program started a worker thread from source text, which the fast path does not run; its next run uses full Linux.");
});

it("prints the explanation and hands on only an uncaught limitation", () => {
  const printed: unknown[] = [], received: unknown[] = [];
  const print = (error: unknown) => { lateFailureReporter(value => { printed.push(value); }, failure => { received.push(failure); }, () => undefined).uncaught(error); };
  const limitation = new VMError("FEATURE_NOT_AVAILABLE", "builtin is not supported", { lateFailure: "unavailable-builtin", subject: "node:sqlite" });
  print(limitation);
  // A fast-path limitation is not the program's error: one plain sentence, not its dump.
  expect(printed).toEqual(["This program uses node:sqlite, which the fast path does not provide; its next run uses full Linux."]);
  expect(received).toEqual([{ kind: "unavailable-builtin", detail: "node:sqlite" }]);
  const plain = new Error("application bug");
  print(plain);
  expect(printed.at(-1)).toBe(plain);
  expect(received).toHaveLength(1);
  const silent: unknown[] = [];
  lateFailureReporter(value => { silent.push(value); }, undefined, () => undefined).uncaught(limitation);
  expect(silent).toEqual([limitation]);
});

it("decodes the late-failure message exactly", () => {
  expect(decodeLateFailure({ kind: "eval-worker", detail: "" })).toEqual({ kind: "eval-worker", detail: "" });
  for (const value of [{ kind: "eval-worker" }, { kind: "x", detail: "" }, { kind: "eval-worker", detail: "a\u0000" }, { kind: "eval-worker", detail: "", extra: 1 }, null]) {
    expect(() => decodeLateFailure(value)).toThrow();
  }
});

it("carries a late failure to the page with its sentence and rejects anything else", () => {
  const wire = encodeAccelerationNotice({ pid: 42, session: 40 }, { kind: "unavailable-builtin", detail: "node:sqlite" });
  expect(wire).toEqual({ pid: 42, session: 40, kind: "unavailable-builtin", detail: "node:sqlite" });
  expect(decodeAccelerationNotice(wire)).toEqual({ pid: 42, session: 40, kind: "unavailable-builtin", detail: "node:sqlite",
    message: "This program uses node:sqlite, which the fast path does not provide; its next run uses full Linux." });
  expect(decodeAccelerationNotice({ ...wire, session: 0 }).session).toBeNull();
  for (const invalid of [{ ...wire, pid: 0 }, { ...wire, session: -1 }, { ...wire, kind: "host-crash" }, { ...wire, detail: "a\nb" }, { ...wire, extra: 1 }, { pid: 42 }, null]) {
    expect(() => decodeAccelerationNotice(invalid)).toThrow();
  }
});

it("reports a missing export a failing process touched, once, and nothing for a process that succeeds", () => {
  const touched = { kind: "unavailable-builtin", detail: "node:http.METHODS" } as const;
  const run = (seen: typeof touched | undefined) => {
    const printed: unknown[] = [], received: unknown[] = [];
    const reporter = lateFailureReporter(value => { printed.push(value); }, failure => { received.push(failure); }, () => seen);
    return { reporter, printed, received };
  };
  const crashed = run(touched), bug = new TypeError("Cannot read properties of undefined (reading 'map')");
  crashed.reporter.uncaught(bug);
  crashed.reporter.exited(1);
  expect(crashed.printed).toEqual([bug, "This program uses node:http.METHODS, which the fast path does not provide; its next run uses full Linux."]);
  expect(crashed.received).toEqual([touched]);
  const exited = run(touched);
  exited.reporter.exited(2);
  expect(exited.received).toEqual([touched]);
  const succeeded = run(touched);
  succeeded.reporter.exited(0);
  expect(succeeded.received).toEqual([]);
  const plain = run(undefined);
  plain.reporter.uncaught(bug);
  plain.reporter.exited(1);
  expect(plain.received).toEqual([]);
  // A structured limitation names itself even after another export was touched.
  const structured = run(touched);
  structured.reporter.uncaught(new VMError("FEATURE_NOT_AVAILABLE", "builtin is not supported", { lateFailure: "unavailable-builtin", subject: "node:sqlite" }));
  expect(structured.received).toEqual([{ kind: "unavailable-builtin", detail: "node:sqlite" }]);
});
