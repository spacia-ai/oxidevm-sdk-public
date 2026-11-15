import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { record } from "../../decode.js";
import { isVMError } from "../../errors.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { ProcessScheduler } from "../assistance/process-scheduler.js";
import { NativeValues, type NativeResult } from "./values.js";

/** Pinned Node 24.18.1's answers to the engine's experimental driver (ADR 0026, 2.13). */
const control = record(JSON.parse(readFileSync(new URL("./experimental.controls.json", import.meta.url), "utf8")), "experimental controls");
const driverPath = fileURLToPath(new URL("../../../../../../tests/fixtures/native-node-api/experimental.cjs", import.meta.url));
const driver: unknown = createRequire(import.meta.url)(driverPath);
const empty = new Uint8Array();

function controlRows(): (readonly unknown[])[] {
  const rows: unknown = control["rows"];
  if (!Array.isArray(rows)) throw new Error("Invalid experimental rows");
  return rows.map((value: unknown) => {
    if (!Array.isArray(value)) throw new Error("Invalid control row");
    const row: readonly unknown[] = value;
    return row;
  });
}
const posted = (row: unknown): boolean => Array.isArray(row) && typeof row[0] === "string" && row[0].startsWith("post/");

/** The fixture's C side, through the value owner's dispatch: [status, value | exception | undefined]. */
function through(values: NativeValues) {
  const call = (operation: string, args: readonly bigint[], answer: (reply: NativeResult) => unknown): unknown[] => {
    let reply: NativeResult;
    try { reply = values.dispatch(operation, args, empty); }
    catch (error) {
      if (isVMError(error)) return [-1, Object.assign(new Error(error.message), { name: `LateFailure:${String(error.detail?.["lateFailure"])}:${String(error.detail?.["subject"])}` })];
      throw error;
    }
    const pending = values.dispatch("napi_is_exception_pending", [], empty).args[0] === 1n;
    if (pending) return [reply.status, values.get(values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0] ?? 0n)];
    return [reply.status, reply.status === 0 ? answer(reply) : undefined];
  };
  const handles = (list: readonly unknown[]): bigint[] => list.map(value => values.add(value));
  return {
    setPrototype: (object: unknown, value: unknown) => call("node_api_set_prototype", [values.add(object), values.add(value)], () => undefined),
    // The fixture passes NULL for an undefined prototype, and NULL travels as 0.
    createObject: (prototype: unknown, names: readonly unknown[], properties: readonly unknown[]) => call("node_api_create_object_with_properties",
      [prototype === undefined ? 0n : values.add(prototype), ...handles(names), ...handles(properties)], reply => values.get(reply.args[0] ?? 0n)),
    isShared: (value: unknown) => call("node_api_is_sharedarraybuffer", [values.add(value)], reply => reply.args[0] === 1n),
    // A posted finalizer's turn is the scheduler's (below); a NULL callback never leaves the host.
    post: (): unknown[] => [0], postWithoutCallback: (): unknown[] => [0],
  };
}

it("replays the driver the engine recorded", () => {
  expect(createHash("sha256").update(readFileSync(driverPath)).digest("hex")).toBe(control["driverSHA256"]);
});

it("sets prototypes, creates objects with properties and tells SharedArrayBuffers apart as pinned Node does", async () => {
  if (typeof driver !== "function") throw new Error("Missing experimental driver");
  // The driver waits 100 ms for its timers; fake them so the replay stays deterministic.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  let text: unknown;
  try {
    const replay: unknown = Reflect.apply(driver, undefined, [through(new NativeValues(() => undefined, () => undefined))]);
    await vi.runAllTimersAsync();
    text = await replay;
  } finally { vi.useRealTimers(); }
  const observed: unknown = JSON.parse(String(text));
  if (!Array.isArray(observed)) throw new Error("Invalid observed rows");
  expect(observed.filter(row => !posted(row))).toEqual(controlRows().filter(row => !posted(row)));
});

it("runs a posted finalizer where pinned Node does: after the turn's ticks and microtasks, before its immediates", async () => {
  const scheduler = new ProcessScheduler(createAsyncContext(), error => { throw error; });
  const order: string[] = [];
  const values = new NativeValues(() => undefined, () => { order.push("finalizer"); });
  values.bindNativeImmediate(run => { scheduler.nativeImmediate(run); });
  let status = -1;
  try {
    // The driver's steps; the host registered the finalizer in slot 0, generation 1.
    scheduler.run(() => {
      status = values.dispatch("node_api_post_finalizer", [4096n], empty).status;
      order.push("sync");
      queueMicrotask(() => order.push("microtask"));
      scheduler.nextTick(() => order.push("nextTick"));
      scheduler.setImmediate(() => order.push("immediate"));
    });
    await scheduler.idle();
  } finally { scheduler.dispose(); values.dispose(); }
  const recorded = controlRows().find(row => row[0] === "post/order"), steps: unknown = recorded?.[2];
  if (recorded === undefined || !Array.isArray(steps)) throw new Error("Missing post/order row");
  // Timers are not the scheduler's; pinned Node ran this 0 ms timeout last.
  expect(["post/order", status, order]).toEqual([recorded[0], recorded[1], steps.filter(step => step !== "timeout")]);
});

it("checks every name before the prototype, whose invalidity aborts Node, and brands SharedArrayBuffers from any realm", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  const create = (...args: bigint[]): unknown => {
    try { return values.dispatch("node_api_create_object_with_properties", args, empty).status; }
    catch (error) { return isVMError(error) ? error.code : error; }
  };
  const [name, number, wrong] = [values.add("a"), values.add(1), values.add(undefined)];
  expect([create(wrong, name, number), create(wrong, number, number), create(0n, name)]).toEqual(["PROTOCOL_ERROR", 4, "PROTOCOL_ERROR"]);
  const shared = (value: unknown) => values.dispatch("node_api_is_sharedarraybuffer", [values.add(value)], empty).args[0];
  expect([shared(runInNewContext("new SharedArrayBuffer(1)")), shared(runInNewContext("new ArrayBuffer(1)"))]).toEqual([1n, 0n]);
});

it("needs the scheduler's native immediates before it can post a finalizer", () => {
  const claims: bigint[] = [];
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined, { claim: id => { claims.push(id); }, retire: () => undefined });
  expect(() => values.dispatch("node_api_post_finalizer", [4096n], empty)).toThrow("Native immediates are not bound");
  expect(claims).toEqual([]);
  values.bindNativeImmediate(() => undefined);
  expect(() => { values.bindNativeImmediate(() => undefined); }).toThrow("already bound");
});

it("refuses operation set 1 to Bun processes, for which no pinned answers exist", () => {
  const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined, { claim: () => undefined, retire: () => undefined, runtime: "bun" });
  const operations = ["napi_get_all_property_names", "napi_run_script", "node_api_set_prototype", "node_api_create_object_with_properties", "node_api_is_sharedarraybuffer", "node_api_post_finalizer"];
  const failures = operations.map(operation => {
    try { values.dispatch(operation, [], empty); return undefined; }
    catch (error) { return isVMError(error) ? [error.code, error.detail?.["lateFailure"], error.detail?.["subject"]] : error; }
  });
  expect(failures).toEqual(operations.map(operation => ["FEATURE_NOT_AVAILABLE", "unsupported-node-api", operation]));
});
