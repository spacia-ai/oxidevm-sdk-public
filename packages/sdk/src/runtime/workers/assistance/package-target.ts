/** Node package maps select a target; filesystem existence is checked afterward.
 * In particular, a missing first array target must not select a later file. */
export function resolvePackageTarget(value: unknown, subpath: string, kind: "require" | "import", internal = false): string {
  const conditions = new Set(["node", "node-addons", "module-sync", kind]);
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const error = (code: string, message: string) => Object.assign(new Error(message), { code });
  const invalid = () => error("ERR_INVALID_PACKAGE_TARGET", `Invalid package target for ${subpath}`);
  const invalidConfig = () => error("ERR_INVALID_PACKAGE_CONFIG", `Invalid package map for ${subpath}`);
  function segments(value: string, subpath = false): void {
    const rejected = () => subpath ? error("ERR_INVALID_MODULE_SPECIFIER", `Invalid package subpath ${value}`) : invalid();
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { throw rejected(); }
    if (/%2f|%5c/iu.test(value) || decoded.split(/[\\/]/u).some(part => part === "." || part === ".." || part.toLowerCase() === "node_modules")) throw rejected();
  }
  function target(value: unknown, capture?: string, depth = 0): string | null | undefined {
    if (depth > 64) throw invalidConfig();
    if (value === null) return null;
    if (typeof value === "string") {
      if (value.startsWith("./")) segments(value.slice(2).split(/[?#]/u)[0] ?? "");
      else if (!internal || value.startsWith("../") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) throw invalid();
      if (capture !== undefined) { segments(capture, true); return value.replaceAll("*", capture); }
      return value;
    }
    if (Array.isArray(value)) {
      let failure: Error | null = null;
      for (const item of value as readonly unknown[]) {
        try {
          const resolved = target(item, capture, depth + 1);
          if (resolved === undefined) continue;
          if (resolved !== null) return resolved;
          failure = null;
        } catch (caught) {
          if (!(caught instanceof Error) || !("code" in caught) || caught.code !== "ERR_INVALID_PACKAGE_TARGET") throw caught;
          failure = caught;
        }
      }
      if (failure !== null) throw failure;
      return null;
    }
    if (!object(value)) throw invalid();
    for (const key of Object.keys(value)) {
      if (String(Number(key) >>> 0) === key && Number(key) !== 0xffff_ffff) throw invalidConfig();
      if (key === "default" || conditions.has(key)) {
        const resolved = target(value[key], capture, depth + 1);
        if (resolved !== undefined) return resolved;
      }
    }
    return undefined;
  }
  let map: Record<string, unknown>;
  if (internal) {
    if (!object(value)) throw invalidConfig();
    map = value;
  } else if (object(value)) {
    const keys = Object.keys(value);
    if (keys.some(key => key.startsWith(".")) && keys.some(key => !key.startsWith("."))) throw invalidConfig();
    map = keys.some(key => key.startsWith(".")) ? value : { ".": value };
  } else map = { ".": value };
  let resolved: string | null | undefined;
  if (Object.hasOwn(map, subpath) && !subpath.includes("*") && !subpath.endsWith("/")) resolved = target(map[subpath]);
  else {
    const patterns = Object.keys(map).filter(key => {
      const star = key.indexOf("*");
      return star !== -1 && star === key.lastIndexOf("*") && subpath.startsWith(key.slice(0, star))
        && subpath.endsWith(key.slice(star + 1)) && subpath.length >= key.length;
    }).sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length);
    const pattern = patterns[0];
    if (pattern !== undefined) {
      const star = pattern.indexOf("*");
      resolved = target(map[pattern], subpath.slice(star, subpath.length - (pattern.length - star - 1)));
    }
  }
  if (resolved === undefined || resolved === null) throw error(internal ? "ERR_PACKAGE_IMPORT_NOT_DEFINED" : "ERR_PACKAGE_PATH_NOT_EXPORTED", `Package does not define ${subpath}`);
  return resolved;
}
