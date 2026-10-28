/** POSIX string operations only. Resolution never reads or caches Linux files. */
export function createNodePath(cwd: () => string) {
  const resolve = (...values: unknown[]): string => {
    const paths = values.map(pathString);
    let combined = "";
    for (let index = paths.length - 1; index >= -1; index--) {
      const path = index === -1 ? cwd() : paths[index];
      if (path === undefined || path === "") continue;
      combined = `${path}/${combined}`;
      if (path.startsWith("/")) break;
    }
    const result = normalize(combined);
    return result.length > 1 && result.endsWith("/") ? result.slice(0, -1) : result;
  };
  const api = {
    sep: "/", delimiter: ":", normalize, resolve, dirname, basename, extname,
    isAbsolute: (value: unknown) => pathString(value).startsWith("/"),
    join: (...values: unknown[]) => normalize(values.map(pathString).filter(value => value !== "").join("/")),
    relative(from: unknown, to: unknown): string {
      const left = resolve(from).split("/").filter(Boolean);
      const right = resolve(to).split("/").filter(Boolean);
      let common = 0;
      while (common < left.length && left[common] === right[common]) common++;
      return [...left.slice(common).map(() => ".."), ...right.slice(common)].join("/");
    },
    parse(value: unknown) {
      const path = pathString(value);
      const base = basename(path);
      const root = path.startsWith("/") ? "/" : "";
      const clean = path.replace(/\/+$/u, "");
      // Node 24 parse('/..') differs from extname('/..'); retain its observable result.
      const ext = clean === "/.." ? "." : extname(path);
      const slash = clean.lastIndexOf("/");
      return { root, dir: slash < 0 ? root : slash === 0 ? "/" : clean.slice(0, slash), base, ext, name: base.slice(0, base.length - ext.length) };
    },
    format(value: unknown): string {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
      const field = (key: string): string => {
        const item: unknown = Reflect.get(value, key);
        return item === undefined ? "" : pathString(item);
      };
      const root = field("root");
      const dir = field("dir") || root;
      const ext = field("ext");
      const base = field("base") || field("name") + (ext === "" || ext.startsWith(".") ? ext : `.${ext}`);
      return dir === "" ? base : dir === root ? dir + base : `${dir}/${base}`;
    },
    toNamespacedPath: (value: unknown): unknown => value,
  };
  // shortcut: win32 exposes platform constants; add its string operations when a qualified workload calls them.
  return Object.assign(api, { posix: api, win32: { sep: "\\", delimiter: ";" } });
}

function pathString(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  return value;
}
function invalid(): TypeError {
  return Object.assign(new TypeError("Path arguments must be strings"), { code: "ERR_INVALID_ARG_TYPE" });
}
function normalize(value: unknown): string {
  const path = pathString(value);
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length !== 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const result = `${absolute ? "/" : ""}${parts.join("/")}` || ".";
  return path.endsWith("/") && result !== "/" ? `${result}/` : result;
}
export function basename(value: unknown, suffix?: unknown): string {
  const original = pathString(value);
  const path = original.replace(/\/+$/u, "");
  const extension = suffix === undefined ? "" : pathString(suffix);
  if (extension !== "" && original === extension) return "";
  if (path === "" && extension !== "" && extension.length <= original.length) return original;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (extension.length > base.length && extension.length <= original.length && extension.endsWith(base)) {
    return base + original.slice(path.length);
  }
  return extension !== "" && base.length > extension.length && base.endsWith(extension) ? base.slice(0, -extension.length) : base;
}
function dirname(value: unknown): string {
  const path = pathString(value);
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  const slash = path.lastIndexOf("/", end - 1);
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  if (slash === 1 && path.startsWith("//")) return "//";
  return path.slice(0, slash);
}
function extname(value: unknown): string {
  const base = basename(value);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || base === ".." ? "" : base.slice(dot);
}
