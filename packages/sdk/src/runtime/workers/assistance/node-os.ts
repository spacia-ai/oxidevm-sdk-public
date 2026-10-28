import { VMError } from "../../errors.ts";
import type { ProcessRuntimeIO } from "./process-io.js";
import { linuxSignalConstants } from "../../process-signals.js";
import { linuxErrnoConstants } from "../../linux-errno.js";

/** Linux remains the resource authority. No browser hardware or cached snapshot
 * participates in Next's worker sizing or memory decisions. */
export function createNodeOs(files: LinuxFiles, env: Readonly<Record<string, string>>, interfaces?: ProcessRuntimeIO["networkInterfaces"]) {
  const read = (path: string) => readLinuxText(files, path);
  function optional(path: string): string | undefined {
    try { return read(path); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  function memory(field: string): number {
    const text = read("/proc/meminfo");
    const value = (key: string) => new RegExp(`^${key}:\\s+(\\d+) kB$`, "mu").exec(text)?.[1];
    const selected = value(field);
    return integer(field === "MemAvailable" && (selected === undefined || selected === "0") ? value("MemFree") : selected, "memory") * 1024;
  }
  function cpuStats() {
    return read("/proc/stat").split("\n").filter(line => /^cpu\d/u.test(line)).map(line => {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 7 || !/^cpu\d+$/u.test(fields[0] ?? "")) throw new TypeError("Invalid Linux CPU statistics");
      return { id: integer(fields[0]?.slice(3), "CPU"), times: {
        user: integer(fields[1], "CPU") * 10, nice: integer(fields[2], "CPU") * 10,
        sys: integer(fields[3], "CPU") * 10, idle: integer(fields[4], "CPU") * 10, irq: integer(fields[6], "CPU") * 10,
      } };
    });
  }
  return {
    constants: { signals: linuxSignalConstants(), errno: { ...linuxErrnoConstants } },
    EOL: "\n", devNull: "/dev/null",
    arch: () => "x64", platform: () => "linux", type: () => "Linux", machine: () => "x86_64", endianness: () => "LE",
    release: () => read("/proc/sys/kernel/osrelease").trimEnd(),
    version: () => read("/proc/sys/kernel/version").trimEnd(),
    hostname: () => read("/proc/sys/kernel/hostname").trimEnd(),
    totalmem: () => memory("MemTotal"), freemem: () => memory("MemAvailable"),
    availableParallelism() {
      if (cpuStats().length === 1) return 1;
      throw new VMError("FEATURE_NOT_AVAILABLE", "os.availableParallelism requires affinity and quota support for multiple guest CPUs", { api: "os.availableParallelism", backend: "assisted-node" });
    },
    cpus() {
      const stats = cpuStats();
      const info = optional("/proc/cpuinfo") ?? "";
      const models = new Map<number, string>();
      for (const section of info.split(/\n\s*\n/u)) {
        const id = /^processor\s*:\s*(\d+)$/mu.exec(section)?.[1];
        const model = /^model name\s*:\s*(.+)$/mu.exec(section)?.[1];
        if (id !== undefined && model !== undefined) models.set(integer(id, "CPU"), model);
      }
      return stats.map(({ id, times }) => {
        const frequency = optional(`/sys/devices/system/cpu/cpu${id}/cpufreq/scaling_cur_freq`);
        return { model: models.get(id) ?? "unknown", speed: frequency === undefined ? 0 : Math.floor(integer(frequency.trim(), "CPU frequency") / 1000), times };
      });
    },
    tmpdir() {
      const path = [env["TMPDIR"], env["TMP"], env["TEMP"]].find(value => value !== undefined && value !== "") ?? "/tmp";
      return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    },
    homedir() {
      if (env["HOME"] !== undefined) return env["HOME"];
      // ADR 0012's authenticated task owner runs application services as UID 1000.
      const home = read("/etc/passwd").split("\n").map(line => line.split(":"))
        .find(fields => fields[2] === "1000")?.[5];
      if (home === undefined) throw new VMError("PROTOCOL_ERROR", "Linux task user has no home directory");
      return home;
    },
    networkInterfaces() {
      if (interfaces !== undefined) return interfaces();
      throw new VMError("FEATURE_NOT_AVAILABLE", "os.networkInterfaces requires the Linux network service", { api: "os.networkInterfaces", backend: "assisted-node" });
    },
  };
}

function integer(value: string | undefined, field: string): number {
  if (value === undefined || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError(`Invalid Linux ${field} value`);
  return Number(value);
}


type LinuxFiles = { readFileSync(path: string, encoding: "utf8"): unknown };
function readLinuxText(files: LinuxFiles, path: string): string {
  const text = files.readFileSync(path, "utf8");
  if (typeof text !== "string" || text.length > 1024 * 1024) throw new VMError("PROTOCOL_ERROR", "Invalid Linux OS information", { path });
  return text;
}

/** /proc/self is resolved by the Linux task's file service in its own PID
 * namespace. These are the process and credentials that own native children. */
export function createProcessIdentity(files: LinuxFiles) {
  function value(field: "Pid" | "PPid" | "Uid" | "Gid", index = 0): number {
    const lines = readLinuxText(files, "/proc/self/status").split("\n").filter(line => line.startsWith(`${field}:`));
    const line = lines[0];
    if (lines.length !== 1 || line === undefined) throw new TypeError(`Invalid Linux ${field} field`);
    const parts = line.slice(field.length + 1).trim().split(/\s+/u);
    const credential = field === "Uid" || field === "Gid";
    if (parts.length !== (credential ? 4 : 1)) throw new TypeError(`Invalid Linux ${field} values`);
    const values = parts.map(part => integer(part, field));
    if (values.some(value => value > (credential ? 0xffff_ffff : 0x7fff_ffff)) || (field === "Pid" && values[0] === 0)) throw new TypeError(`Invalid Linux ${field} range`);
    const selected = values[index];
    if (selected === undefined) throw new TypeError(`Missing Linux ${field} value`);
    return selected;
  }
  return {
    get pid() { return value("Pid"); }, get ppid() { return value("PPid"); },
    getuid: () => value("Uid"), geteuid: () => value("Uid", 1),
    getgid: () => value("Gid"), getegid: () => value("Gid", 1),
  };
}
