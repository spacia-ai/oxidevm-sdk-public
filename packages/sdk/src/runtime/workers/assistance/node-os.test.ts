import { expect, it } from "vitest";
import { createNodeOs, createProcessIdentity } from "./node-os.ts";
import { constants } from "node:os";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("matches native Linux x64 signal constants, including aliases", () => {
  const os = createNodeOs({ readFileSync() { throw new Error("Constant reads must not request guest files"); } }, {});
  const value: unknown = Reflect.get(os, "constants");
  expect(value).toMatchObject({ signals: constants.signals });
});

it("uses live Linux guest CPU and memory values rather than browser hardware", () => {
  const sources = new Map([
    ["/proc/stat", "cpu 1 2 3 4 5 6 7 8\ncpu0 10 20 30 40 50 60 70 80\nintr 0\n"],
    ["/proc/cpuinfo", "processor\t: 0\nmodel name\t: OxideVM CPU\ncpu MHz\t: 9999\n\n"],
    ["/proc/meminfo", "MemTotal: 1572864 kB\nMemFree: 1000 kB\nMemAvailable: 2000 kB\n"],
    ["/proc/sys/kernel/osrelease", "6.12.1\n"],
    ["/proc/sys/kernel/version", "#1 SMP\n"],
    ["/proc/sys/kernel/hostname", "guest\n"],
  ]);
  const os = createNodeOs({ readFileSync(path) {
    const source = sources.get(path);
    if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return source;
  } }, {});
  expect(os.cpus()).toEqual([{ model: "OxideVM CPU", speed: 0,
    times: { user: 100, nice: 200, sys: 300, idle: 400, irq: 600 } }]);
  expect(os.totalmem()).toBe(1536 * 1024 ** 2);
  expect(os.availableParallelism()).toBe(1);
  expect(os.freemem()).toBe(2000 * 1024);
  sources.set("/proc/meminfo", "MemTotal: 1572864 kB\nMemFree: 512 kB\nMemAvailable: 0 kB\n");
  expect(os.freemem()).toBe(512 * 1024);
  sources.set("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "1234567\n");
  expect(os.cpus()[0]?.speed).toBe(1234);
  expect([os.platform(), os.arch(), os.type(), os.machine(), os.endianness()]).toEqual(["linux", "x64", "Linux", "x86_64", "LE"]);
  expect([os.release(), os.version(), os.hostname()]).toEqual(["6.12.1", "#1 SMP", "guest"]);
  sources.set("/proc/stat", "cpu0 invalid\n");
  expect(() => os.cpus()).toThrow("CPU");
});

it("keeps environment-based temporary directories live and propagates Linux read errors", () => {
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  const env: Record<string, string> = { TMPDIR: "/workspace/tmp/" };
  const os = createNodeOs({ readFileSync() { throw error; } }, env);
  expect(os.tmpdir()).toBe("/workspace/tmp");
  env["TMPDIR"] = "/";
  expect(os.tmpdir()).toBe("/");
  delete env["TMPDIR"];
  expect(os.tmpdir()).toBe("/tmp");
  expect(() => os.totalmem()).toThrow(error);
  expect(() => os.networkInterfaces()).toThrow("os.networkInterfaces");
});

it("requests network interfaces from the live Linux service on every call", () => {
  let reads = 0;
  const os = createNodeOs({ readFileSync() { throw new Error("Unexpected file read"); } }, {}, () => { reads++; return {}; });
  expect(os.networkInterfaces()).toEqual({}); expect(os.networkInterfaces()).toEqual({}); expect(reads).toBe(2);
});


it("reads process and credential identity from live Linux status without synthesizing IDs", () => {
  let source = "Name:\tfile-service\nPid:\t42\nPPid:\t1\nUid:\t1000\t1001\t1002\t1003\nGid:\t2000\t2001\t2002\t2003\n";
  const identity = createProcessIdentity({ readFileSync(path) {
    expect(path).toBe("/proc/self/status"); return source;
  } });
  expect([identity.pid, identity.ppid, identity.getuid(), identity.geteuid(), identity.getgid(), identity.getegid()]).toEqual([42, 1, 1000, 1001, 2000, 2001]);
  expect(typeof Object.getOwnPropertyDescriptor(identity, "pid")?.get).toBe("function");
  source = source.replace("PPid:\t1", "PPid:\t9");
  expect(identity.ppid).toBe(9);
  source += "Pid:\t99\n";
  expect(() => identity.pid).toThrow();
  source = "Uid:\t4294967296\t1\t2\t3\n";
  expect(() => identity.getuid()).toThrow();
});
