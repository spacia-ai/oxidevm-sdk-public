import { describe, expect, it } from "vitest";
import type { Capability, ProcessSignals } from "../capabilities.js";
import type { HostArtifacts } from "../define.js";
import { buildHost } from "./host.js";
import { fakeLinux } from "./linux.test-support.js";

const artifacts: HostArtifacts = { compile: () => Promise.reject(new Error("unused")), bytes: () => Promise.reject(new Error("unused")), url: name => `https://app.test/${name}` };
const signals: ProcessSignals = Object.freeze({ trap: () => Promise.reject(new Error("unused")), raise: () => Promise.reject(new Error("unused")) });
const build = (capabilities: readonly Capability[], lines: string[] = []) => {
  const linux = fakeLinux({ args: [] });
  const built = buildHost({ linux, capabilities, options: { mode: "fast" }, artifacts, signal: new AbortController().signal, signals });
  return { ...built, linux, lines, members: Object.keys(built.host).sort() };
};
const BASE = ["artifacts", "fail", "kit", "log", "options", "signal", "stdio"];

/** The sorted member names of a host member, or an empty list when it is absent or not an object. */
function memberNames(host: object, name: string): readonly string[] {
  const member: unknown = Reflect.get(host, name);
  return typeof member === "object" && member !== null ? Object.keys(member).sort() : [];
}

describe("host construction", () => {
  it("gives only the base members when no capability is declared", () => {
    expect(build([]).members).toEqual(BASE);
  });

  it("adds exactly the members of the declared capabilities", () => {
    expect(build(["files.sync"]).members).toEqual([...BASE, "fs"].sort());
    expect(build(["files.async", "sockets.connect"]).members).toEqual([...BASE, "files", "sockets"].sort());
    expect(build(["process.info"]).members).toEqual([...BASE, "process"].sort());
  });

  it("limits sockets to client operations and merges the two process capabilities", () => {
    const { host } = build(["sockets.connect", "process.info", "process.spawn"]);
    expect(memberNames(host, "sockets")).toEqual(["address", "close", "connect", "read", "shutdown", "socket", "write"]);
    expect(memberNames(host, "process")).toEqual(["cwd", "info", "signal", "spawn", "wait"]);
    expect(memberNames(build(["process.info"]).host, "process")).toEqual(["cwd", "info"]);
  });

  it("freezes the host and its descriptor record so an adapter cannot widen its own access", () => {
    const { host } = build(["files.sync"]);
    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(Reflect.get(host, "stdio"))).toBe(true);
    expect(() => { Reflect.set(host, "sockets", {}); }).not.toThrow();
    expect("sockets" in host).toBe(false);
  });

  it("writes log lines to standard error, bounded in size and in whole characters", () => {
    const { log, linux } = build([]);
    log("hello");
    log("é".repeat(10_000));
    expect(linux.stderrLines[0]).toBe("hello");
    const long = linux.stderrLines[1] ?? "";
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(8192);
    expect(long).not.toContain("�");
    expect(long.length).toBeGreaterThan(4000);
  });

  it("returns the failure status after logging, and refuses a status the runner owns", () => {
    const { host, linux } = build([]);
    const fail = (status: number, message: string): unknown => {
      const member: unknown = Reflect.get(host, "fail");
      if (typeof member !== "function") throw new Error("host.fail is missing");
      const result: unknown = Reflect.apply(member, undefined, [status, message]);
      return result;
    };
    expect(fail(2, "bad input")).toBe(2);
    expect(linux.stderrLines).toEqual(["bad input"]);
    for (const status of [0, 120, 125, -1, 1.5, Number.NaN]) expect(() => fail(status, "x"), String(status)).toThrow(/1 to 119/u);
    expect(linux.stderrLines).toHaveLength(1);
  });
});

// Engine ADR 0027: process.signals adds host.process.signals, the process's own signal owner.
describe("host.process.signals", () => {
  it("exists only when declared, beside the other process members", () => {
    expect(memberNames(build(["process.signals"]).host, "process")).toEqual(["signals"]);
    const { host } = build(["process.info", "process.signals"]);
    expect(memberNames(host, "process")).toEqual(["cwd", "info", "signals"]);
    expect(Reflect.get(Object(Reflect.get(host, "process")), "signals")).toBe(signals);
    expect(memberNames(build(["process.info", "process.spawn"]).host, "process")).not.toContain("signals");
    expect(Object.isFrozen(Reflect.get(host, "process"))).toBe(true);
  });

  it("reports a read of an undeclared signals member and names the capability that provides it", () => {
    const linux = fakeLinux({ args: [] }), reached: unknown[] = [];
    const inputs = { linux, options: {}, artifacts, signal: new AbortController().signal, signals, undeclared: (access: unknown) => { reached.push(access); } };
    const partial = buildHost({ ...inputs, capabilities: ["process.info"] }).host;
    expect(Reflect.get(Object(Reflect.get(partial, "process")), "signals")).toBeUndefined();
    const none = buildHost({ ...inputs, capabilities: [] }).host;
    expect(Reflect.get(none, "process")).toBeUndefined();
    expect(reached).toEqual([{ member: "process.signals", capabilities: ["process.signals"] }, { member: "process", capabilities: ["process.info", "process.spawn", "process.signals"] }]);
  });
});
