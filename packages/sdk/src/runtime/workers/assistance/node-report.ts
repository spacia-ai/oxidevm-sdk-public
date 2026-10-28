import { VMError } from "../../errors.js";

/** Addon selection reads real Linux mappings. Heap and full diagnostic reports remain unavailable. */
export function createNodeReport(files: { readFileSync(path: string, encoding: "utf8"): unknown }, nodeVersion: string) {
  const unavailable = (): never => { throw new VMError("FEATURE_NOT_AVAILABLE", "Full Node diagnostic reports and heap data are unavailable"); };
  return {
    excludeNetwork: true,
    getReport() {
      const maps = files.readFileSync("/proc/self/maps", "utf8");
      if (typeof maps !== "string") throw new VMError("PROTOCOL_ERROR", "Invalid Linux process mappings");
      const sharedObjects = [...new Set(maps.split("\n").flatMap(line => {
        const path = line.trim().split(/\s+/u).slice(5).join(" ");
        return path.startsWith("/") && /(?:\.so(?:\.|$)|ld-musl-)/u.test(path) ? [path] : [];
      }))];
      return { header: { nodejsVersion: `v${nodeVersion}`, arch: "x64", platform: "linux" }, sharedObjects,
        get javascriptHeap(): never { return unavailable(); }, get libuv(): never { return unavailable(); },
        get resourceUsage(): never { return unavailable(); }, get workers(): never { return unavailable(); },
      };
    },
    writeReport: unavailable,
  };
}
