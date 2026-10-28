import { expect, it, vi } from "vitest";
import { deliverProcessSignal, installProcessIpc, NodeProcess, validateNodeEnvironment } from "./node-process.ts";
import { createWarningPrinter } from "./node-warnings.ts";

it("publishes admitted Node build config as an enumerable non-writable data property", () => {
  const config = Object.freeze({ variables: Object.freeze({ target_arch: "x64" }), target_defaults: Object.freeze({}) });
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1", undefined, undefined, { config: { value: config, writable: false, configurable: true }, features: { value: {}, writable: false, configurable: false } });
  expect(Object.getOwnPropertyDescriptor(process, "config")).toEqual({ value: config, writable: false, enumerable: true, configurable: true });
  expect(Reflect.get(process, "config")).toBe(config);
  expect(Reflect.set(process, "config", {})).toBe(false);
});

it("preserves Bun's writable config property and separately owned mutable variables", () => {
  const config = Object.freeze({ variables: { target_arch: "x64" }, target_defaults: {} });
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.3.0", undefined, undefined, { config: { value: config, writable: true, configurable: true }, features: { value: {}, writable: true, configurable: true } });
  expect(Object.getOwnPropertyDescriptor(process, "config")).toEqual({ value: config, writable: true, enumerable: true, configurable: true });
  expect(Reflect.set(config.variables, "target_arch", "changed")).toBe(true);
  expect(Reflect.set(process, "config", { replacement: true })).toBe(true);
  expect(Reflect.get(process, "config")).toEqual({ replacement: true });
});

it("retains Node exit-code validation and emits exit exactly once before termination", () => {
  const stopped = new Error("terminated");
  const terminate = vi.fn<(code: number) => never>(() => { throw stopped; });
  const process = new NodeProcess(terminate, "24.18.1");
  expect(process.version).toBe("v24.18.1");
  expect(process.versions).toEqual({ node: "24.18.1" });
  const seen: unknown[] = [];
  process.on("exit", code => { seen.push(code); process.exitCode = 258; });
  expect(Object.keys(process)).toContain("exitCode");
  expect(process.exitCode).toBeUndefined();
  process.exitCode = "-1";
  expect(() => process.exit()).toThrow(stopped);
  expect(seen).toEqual([-1]);
  expect(terminate).toHaveBeenLastCalledWith(2);
  const exit = process.exit;
  expect(() => exit()).toThrow(stopped);
  expect(seen).toEqual([-1]);
  process.exitCode = " ";
  expect(process.exitCode).toBe(0);
  process.exitCode = null;
  expect(process.exitCode).toBeUndefined();
  process.exitCode = 2147483648;
  expect(process.exitCode).toBe(-2147483648);
  for (const value of [true, "", "abc", {}, []]) expect(() => { process.exitCode = value; }).toThrow(TypeError);
  for (const value of [1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => { process.exitCode = value; }).toThrow(RangeError);
});

it("reports monotonic process time and borrows nanoseconds in elapsed tuples", () => {
  const process = new NodeProcess(() => { throw new Error("terminated"); }, "24.18.1", () => 1234.5);
  expect(process.hrtime()).toEqual([1, 234500000]);
  expect(process.hrtime.bigint()).toBe(1234500000n);
  expect(process.hrtime([0, 900000000])).toEqual([0, 334500000]);
  expect(process.uptime()).toBe(1.2345);
  expect(() => process.hrtime([0])).toThrow(RangeError);
  expect(() => process.hrtime("invalid")).toThrow(TypeError);
});

it("delivers warnings through nextTick with original errors and deprecation policy", () => {
  const queued: (() => void)[] = [];
  const process = new NodeProcess(() => { throw new Error("terminated"); }, "24.18.1", () => 0, callback => { queued.push(callback); });
  const warnings: unknown[] = [];
  process.on("warning", warning => { warnings.push(warning); });
  process.emitWarning("cache option", { type: "DeprecationWarning", code: "DEP_TEST", detail: "use the new option" });
  expect(warnings).toEqual([]);
  queued.shift()?.();
  expect(warnings[0]).toMatchObject({ name: "DeprecationWarning", message: "cache option", code: "DEP_TEST", detail: "use the new option" });
  const original = new Error("original");
  process.emitWarning(original, "IgnoredType", "IGNORED");
  queued.shift()?.();
  expect(warnings[1]).toBe(original);
  process.noDeprecation = true;
  process.emitWarning("suppressed", "DeprecationWarning");
  expect(queued).toHaveLength(0);
  process.noDeprecation = false;
  process.throwDeprecation = true;
  process.emitWarning("throw later", "DeprecationWarning");
  expect(queued.shift()).toThrow("throw later");
  expect(warnings).toHaveLength(2);
  for (const value of [undefined, 3, {}]) expect(() => process.emitWarning(value)).toThrow(TypeError);
  expect(() => process.emitWarning("message", 3)).toThrow(TypeError);
  expect(() => process.emitWarning("message", "Warning", 3)).toThrow(TypeError);
});

it("prints warning codes and detail once per event and retains trace and listener controls", () => {
  const process = new NodeProcess(() => { throw new Error("terminated"); }, "24.18.1");
  const output: string[] = [];
  const print = createWarningPrinter(process, text => { output.push(text); }, () => 42);
  process.on("warning", print);
  const warning = Object.assign(new Error("option changed"), { name: "DeprecationWarning", code: "DEP_TEST", detail: "use another option", stack: "STACK" });
  process.emit("warning", warning);
  expect(output[0]).toBe("(node:42) [DEP_TEST] DeprecationWarning: option changed\nuse another option\n(Use `node --trace-deprecation ...` to show where the warning was created)\n");
  process.emit("warning", warning);
  expect(output[1]).not.toContain("(Use");
  process.traceDeprecation = true;
  process.emit("warning", warning);
  expect(output[2]).toBe("(node:42) [DEP_TEST] STACK\nuse another option\n");
  process.noDeprecation = true;
  process.emit("warning", warning);
  expect(output).toHaveLength(3);
  process.removeListener("warning", print);
  process.emit("warning", new Error("not printed"));
  expect(output).toHaveLength(3);
});


it("rejects unsupported engine options before executing an assisted entrypoint", () => {
  for (const value of [undefined, "", " \t\n"]) {
    expect(() => validateNodeEnvironment(value === undefined ? {} : { NODE_OPTIONS: value }, "/workspace/entry.cjs")).not.toThrow();
  }
  for (const value of ["--max-old-space-size=2048", "--heapsnapshot-signal=SIGUSR2", "--require /workspace/private-hook.cjs"]) {
    let failure: unknown;
    try { validateNodeEnvironment({ NODE_OPTIONS: value }, "/workspace/entry.cjs"); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { api: "NODE_OPTIONS", importer: "/workspace/entry.cjs" } });
    expect(String(failure)).not.toContain(value);
  }
});

it("admits only implemented source-map NODE_OPTIONS and respects the final flag", () => {
  expect(validateNodeEnvironment({}, "/entry.cjs")).toBe(false);
  expect(validateNodeEnvironment({ NODE_OPTIONS: '--enable-source-maps' }, "/entry.cjs")).toBe(true);
  expect(validateNodeEnvironment({ NODE_OPTIONS: '"--enable-source-maps" --no-enable-source-maps' }, "/entry.cjs")).toBe(false);
  expect(validateNodeEnvironment({ NODE_OPTIONS: "--enable-source-maps" }, "/entry.cjs", ["--no-enable-source-maps"])).toBe(false);
  expect(() => validateNodeEnvironment({ NODE_OPTIONS: '--enable-source-maps --require secret' }, "/entry.cjs")).toThrow("NODE_OPTIONS");
});

it("exposes the IPC channel on the child process and references it only through message listeners", () => {
  const process = new NodeProcess(() => { throw new Error("terminated"); }, "24.18.1");
  const channel = { connected: true, hasReferences: false, sent: [] as unknown[], listeners: 0, disconnected: 0,
    send(message: unknown, callback?: (error: Error | null) => void) { this.sent.push(message); callback?.(null); return true; },
    disconnect() { this.connected = false; this.disconnected += 1; }, ref() {}, unref() {}, setListeners(count: number) { this.listeners = count; } };
  installProcessIpc(process, channel);
  expect(process.connected).toBe(true);
  expect(process.send({ ready: true })).toBe(true);
  expect(channel.sent).toEqual([{ ready: true }]);
  const listener = () => {};
  process.on("message", listener);
  expect(channel.listeners).toBe(1);
  process.removeListener("message", listener);
  expect(channel.listeners).toBe(0);
  process.disconnect();
  expect(process.connected).toBe(false);
  expect(channel.disconnected).toBe(1);
  // Signals reach listeners by name; without a listener the process ends by that signal.
  const ended = vi.fn<(signal: 1 | 2 | 9 | 15) => never>(() => { throw new Error("ended"); });
  expect(() => deliverProcessSignal(process, "TERM", ended)).toThrow("ended");
  expect(ended).toHaveBeenCalledWith(15);
  const seen: unknown[] = [];
  process.on("SIGINT", (...args) => seen.push(args));
  deliverProcessSignal(process, "INT", ended);
  expect(seen).toEqual([["SIGINT"]]);
  expect(ended).toHaveBeenCalledOnce();
});
