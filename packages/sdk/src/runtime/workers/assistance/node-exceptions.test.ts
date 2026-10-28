import { expect, it } from "vitest";
import { NodeProcess } from "./node-process.js";
import { deliverProcessException } from "./node-exceptions.js";
import { VMError } from "../../errors.js";

it("forwards handled rejection events with the original Promise and no uncaught escalation", () => {
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1"), promise = Promise.resolve(), seen: unknown[] = [];
  process.on("rejectionHandled", (...args) => { seen.push(args); });
  process.on("uncaughtExceptionMonitor", () => { throw new Error("unexpected monitor"); });
  expect(deliverProcessException(process, undefined, "rejectionHandled", () => { throw new Error("unexpected output"); }, undefined, promise)).toBe(true);
  expect(seen).toEqual([[promise]]);
});

it("delivers native callback exceptions through the same Node monitor and handler", () => {
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1"), error = new Error("application");
  const seen: unknown[] = [];
  process.on("uncaughtExceptionMonitor", (...args) => seen.push(["monitor", ...args]));
  process.on("uncaughtException", (...args) => seen.push(["handler", ...args]));
  expect(deliverProcessException(process, error, "uncaughtException", () => { throw new Error("unexpected output"); })).toBe(true);
  expect(seen).toEqual([["monitor", error, "uncaughtException"], ["handler", error, "uncaughtException"]]);
  expect(deliverProcessException(process, new VMError("PROTOCOL_ERROR", "bad frame"), "uncaughtException", () => {})).toBe(false);
  expect(seen).toHaveLength(2);
});

it("delivers the original promise to rejection listeners before uncaught escalation", () => {
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1");
  const reason = new Error("rejected"), promise = Promise.resolve(), seen: unknown[] = [];
  process.on("unhandledRejection", (...args) => { seen.push(args); });
  process.on("uncaughtExceptionMonitor", () => { throw new Error("unexpected monitor"); });
  expect(deliverProcessException(process, reason, "unhandledRejection", () => { throw new Error("unexpected output"); }, undefined, promise)).toBe(true);
  expect(seen).toEqual([[reason, promise]]);
});

it("routes a failing rejection listener through normal uncaught handling", () => {
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1"), failure = new Error("listener-failed"), seen: unknown[] = [];
  process.on("unhandledRejection", () => { throw failure; });
  process.on("uncaughtExceptionMonitor", (...args) => { seen.push(["monitor", ...args]); });
  process.on("uncaughtException", (...args) => { seen.push(["handler", ...args]); });
  expect(deliverProcessException(process, new Error("original"), "unhandledRejection", () => {}, undefined, Promise.resolve())).toBe(true);
  expect(seen).toEqual([["monitor", failure, "uncaughtException"], ["handler", failure, "uncaughtException"]]);
});

it("keeps unhandled application errors distinct from transport errors and handler failures", () => {
  const codes: number[] = [], printed: unknown[] = [], stopped = new Error("stopped");
  const process = new NodeProcess(code => { codes.push(code); throw stopped; }, "24.18.1");
  const error = new Error("application");
  expect(() => deliverProcessException(process, error, "unhandledRejection", value => { printed.push(value); })).toThrow(stopped);
  expect(codes).toEqual([1]); expect(printed).toEqual([error]);
  const handlerFailure = new Error("handler failed"), second = new NodeProcess(code => { codes.push(code); throw stopped; }, "24.18.1");
  second.on("uncaughtException", () => { throw handlerFailure; });
  expect(() => deliverProcessException(second, error, "uncaughtException", value => { printed.push(value); })).toThrow(stopped);
  expect(codes).toEqual([1, 7]); expect(printed).toEqual([error, handlerFailure]);
});

it("reports unhandled errors to the parent worker before exit but keeps handled errors local", () => {
  const order: unknown[] = [], stopped = new Error("stopped"), error = new TypeError("application");
  const process = new NodeProcess(code => { order.push(["exit", code]); throw stopped; }, "24.18.1");
  const notify = (value: unknown) => { order.push(["parent", value]); };
  expect(() => deliverProcessException(process, error, "uncaughtException", value => { order.push(["print", value]); }, notify)).toThrow(stopped);
  expect(order).toEqual([["parent", error], ["exit", 1]]);
  order.length = 0;
  process.on("uncaughtException", () => { order.push("handled"); });
  expect(deliverProcessException(process, error, "uncaughtException", () => {}, notify)).toBe(true);
  expect(order).toEqual(["handled"]);
});
