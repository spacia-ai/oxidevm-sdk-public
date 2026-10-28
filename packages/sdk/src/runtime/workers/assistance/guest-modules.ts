import { VMError } from "../../errors.ts";
import type { LocalModuleFiles, ModuleDependencyIdentity, ModulePathInfo } from "./module-files.ts";
import { createNodePath } from "./node-path.ts";
import { fileURLToPath } from "./node-url.ts";
import { resolvePackageTarget } from "./package-target.ts";
import { isNodeBuiltin } from "./commonjs.ts";

interface GuestModuleFiles {
  readFileSync(path: string, encoding: "utf8"): unknown;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean } | undefined;
  realpathSync(path: string): string;
}

/** Entries Rust freezes in each root; other dot-entries such as `.vite` or `.cache` stay live. */
function frozenEntry(name: string): boolean {
  return name !== "" && (!name.startsWith(".") || name === ".pnpm" || name === ".bun" || name === ".bin");
}

/** Linux owns lookups. Rust publishes the frozen roots (ADR 0026); only metadata inside their
 * frozen entries survives a call, and installed code outside every root is refused. */
export function createGuestModules(files: GuestModuleFiles, selected?: ModuleDependencyIdentity, loadNative?: (path: string) => unknown, pathInfo?: (path: string) => ModulePathInfo): LocalModuleFiles {
  const dependencies = selected === undefined ? undefined : Object.freeze({ ...selected });
  const roots = dependencies !== undefined && "profile" in dependencies ? dependencies.roots : undefined;
  const paths = createNodePath(() => "/");
  const canonicalMetadata = new Map<string, ModulePathInfo>();
  const packageMetadata = new Map<string, Record<string, unknown>>();
  /** The first entry name below the root that holds `path`; roots never overlap. */
  function entry(path: string) {
    const root = roots?.find(candidate => path === candidate.path || path.startsWith(candidate.path + "/"));
    return root === undefined ? undefined : { root, name: path.slice(root.path.length + 1).split("/")[0] ?? "" };
  }
  function frozen(path: string): boolean {
    const found = entry(path);
    return found !== undefined && (found.root.kind === "image" || frozenEntry(found.name));
  }
  /** The live tool-cache directory holding `path`, without a further node_modules below it. */
  function liveCache(path: string): string | undefined {
    const found = entry(path);
    if (found === undefined || found.root.kind === "image" || frozenEntry(found.name) || found.name.length < 2) return undefined;
    const cache = `${found.root.path}/${found.name}`;
    return path.slice(cache.length).split("/").includes("node_modules") ? undefined : cache;
  }
  function immutable(path: string): boolean {
    return pathInfo !== undefined && paths.normalize(path) === path && frozen(path);
  }
  function cache<Value>(owner: Map<string, Value>, path: string, value: Value, canonicalPath = path): void {
    if (!immutable(path) || !immutable(canonicalPath)) return;
    if (owner.size >= 32_768) owner.clear();
    owner.set(path, value);
  }
  function admit(path: string): void {
    if (path.includes("\0") || /[\r\n]/u.test(path)) throw new TypeError("Invalid module path");
    const installed = path.split("/").includes("node_modules");
    if (roots !== undefined && !installed && !path.startsWith("/workspace/") && !frozen(paths.normalize(path))) throw unsupported(path, "module is outside the admitted code roots");
    if (dependencies === undefined && installed) throw unsupported(path, "installed-package execution is unavailable");
    if (roots !== undefined && installed) {
      const normalized = paths.normalize(path), cacheDirectory = liveCache(normalized);
      if (!frozen(normalized) && (cacheDirectory === undefined || path.endsWith(".node") || normalized === cacheDirectory)) throw unsupported(path, "installed module is outside the admitted dependency generation");
    }
    if (path.endsWith(".node") && loadNative === undefined) throw unsupported(path, "native addons are unavailable");
  }
  const absolute = (specifier: string, parent: string) => paths.resolve(paths.dirname(parent), specifier);
  function source(path: string): string {
    const value = files.readFileSync(canonical(path), "utf8");
    if (typeof value !== "string") throw new VMError("PROTOCOL_ERROR", "Guest module read did not return UTF-8 text");
    return value;
  }
  function metadata(path: string): Record<string, unknown> | undefined {
    const cached = packageMetadata.get(path);
    if (cached !== undefined) return cached;
    let bytes: string;
    try { bytes = source(path); } catch (error) { if (missing(error)) return undefined; throw error; }
    let value: unknown;
    try { value = JSON.parse(bytes); }
    catch { throw invalidMetadata(path); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidMetadata(path);
    }
    const info: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    for (const key of ["name", "type"]) {
      if (Object.hasOwn(info, key) && typeof info[key] !== "string") throw invalidMetadata(path);
    }
    if (canonicalMetadata.has(path)) cache(packageMetadata, path, info);
    return info;
  }
  function stat(path: string) {
    try {
      if (pathInfo === undefined) return files.statSync(path);
      const info = inspect(path);
      return { isFile: () => (info.mode & 0o170000) === 0o100000, isDirectory: () => (info.mode & 0o170000) === 0o040000, canonical: info.path };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  function packagePath(path: string): void {
    if (liveCache(paths.normalize(path)) !== undefined && stat(path)?.isDirectory() === true) throw unsupported(path, "project caches cannot serve as installed package roots");
  }
  function canonical(path: string): string {
    return pathInfo === undefined ? validateCanonical(path, files.realpathSync(path)) : inspect(path).path;
  }
  function inspect(path: string): ModulePathInfo {
    const cached = canonicalMetadata.get(path);
    if (cached !== undefined) return cached;
    if (pathInfo === undefined) throw new VMError("PROTOCOL_ERROR", "Canonical metadata provider is absent");
    const info = pathInfo(path);
    validateCanonical(path, info.path);
    cache(canonicalMetadata, path, info, info.path);
    return info;
  }
  function validateCanonical(path: string, result: string): string {
    if (!result.startsWith("/") || result.includes("\0")) throw new VMError("PROTOCOL_ERROR", "Invalid canonical module path");
    // Rust classified every link of the frozen roots; a target must still be admissible code.
    admit(path);
    admit(result);
    return result;
  }
  function file(path: string): string | undefined {
    for (const candidate of [path, `${path}.js`, `${path}.json`, `${path}.node`]) {
      const info = stat(candidate);
      if (info?.isFile() === true) {
        admit(candidate);
        return "canonical" in info ? info.canonical : canonical(candidate);
      }
    }
    return undefined;
  }
  function commonjs(path: string): string | undefined {
    const direct = file(path);
    if (direct !== undefined) return direct;
    if (stat(path)?.isDirectory() !== true) return undefined;
    const main = metadata(`${path}/package.json`)?.["main"];
    if (typeof main === "string" && main.length !== 0) {
      const target = absolute(main, `${path}/package.json`);
      const resolved = file(target) ?? file(`${target}/index`);
      if (resolved !== undefined) return resolved;
    }
    return file(`${path}/index`);
  }
  function scope(parent: string): { root: string; info: Record<string, unknown> } | undefined {
    for (let root = paths.dirname(parent); ; root = paths.dirname(root)) {
      if (paths.basename(root) === "node_modules") return undefined;
      const info = metadata(paths.join(root, "package.json"));
      if (info !== undefined) return { root, info };
      if (root === "/") return undefined;
    }
  }
  function exact(path: string, kind: "require" | "import"): string | undefined {
    const value = stat(path);
    if (value?.isFile() === true) return "canonical" in value ? value.canonical : canonical(path);
    if (kind === "import" && value?.isDirectory() === true) throw Object.assign(new Error(`Directory import is unsupported: ${path}`), { code: "ERR_UNSUPPORTED_DIR_IMPORT" });
    return undefined;
  }
  function mapped(root: string, map: unknown, key: string, kind: "require" | "import", internal: boolean, depth: number): string | undefined {
    const target = resolvePackageTarget(map, key, kind, internal);
    if (!target.startsWith("./")) {
      const result = resolve(target, paths.join(root, "package.json"), kind, depth + 1);
      // Node 24's CJS imports-map path requires a file URL even for builtin targets.
      if (kind === "require" && result.startsWith("node:")) throw Object.assign(new Error("Package import requires a file URL"), { code: "ERR_INVALID_URL_SCHEME" });
      return result;
    }
    return exact(paths.resolve(root, decodeURIComponent(target.split(/[?#]/u)[0] ?? "")), kind);
  }
  function packageRoot(root: string, subpath: string, kind: "require" | "import", depth: number): string | undefined {
    packagePath(root);
    const info = metadata(paths.join(root, "package.json"));
    if (info?.["exports"] !== undefined && info["exports"] !== null) return mapped(root, info["exports"], subpath, kind, false, depth);
    const path = paths.join(root, subpath);
    return kind === "require" || subpath === "." ? commonjs(path) : exact(path, kind);
  }
  function resolve(specifier: string, parent: string, kind: "require" | "import", depth = 0): string {
    if (depth > 64) throw unsupported(specifier, "package import map recursion exceeds its bound");
    if (kind === "import" && specifier.startsWith("file:")) {
      const url = new URL(specifier);
      if (/%2f|%5c/iu.test(url.pathname)) throw Object.assign(new Error("Encoded path separator in file URL"), { code: "ERR_INVALID_MODULE_SPECIFIER" });
      if (url.search !== "" || url.hash !== "") throw unsupported(specifier, "ESM URL query and fragment identities are unavailable");
      return resolve(fileURLToPath(url), parent, kind, depth + 1);
    }
    if (isNodeBuiltin(specifier)) return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
    if (!(specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../"))) {
      if (dependencies === undefined) throw unsupported(specifier, "installed-package resolution is unavailable");
      const own = scope(parent);
      if (specifier.startsWith("#")) {
        if (specifier === "#" || specifier.startsWith("#/")) throw Object.assign(new Error(`Invalid module specifier ${specifier}`), { code: "ERR_INVALID_MODULE_SPECIFIER" });
        if (own === undefined || own.info["imports"] === undefined) throw Object.assign(new Error(`Package does not define ${specifier}`), { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" });
        const result = mapped(own.root, own.info["imports"], specifier, kind, true, depth);
        if (result !== undefined) return result;
      } else {
        const parts = specifier.split("/");
        const count = specifier.startsWith("@") ? 2 : 1;
        const name = parts.slice(0, count).join("/");
        if (parts.length < count || parts.slice(0, count).some(part => part === "" || part === "." || part === "..") || /[%\\\0]/u.test(name)) {
          throw Object.assign(new Error(`Invalid package name ${name}`), { code: "ERR_INVALID_MODULE_SPECIFIER" });
        }
        const subpath = parts.length === count ? "." : `./${parts.slice(count).join("/")}`;
        if (own?.info["name"] === name && own.info["exports"] !== undefined && own.info["exports"] !== null) {
          packagePath(own.root);
          const result = mapped(own.root, own.info["exports"], subpath, kind, false, depth);
          if (result !== undefined) return result;
        } else {
          for (let directory = paths.dirname(parent); ; directory = paths.dirname(directory)) {
            if (paths.basename(directory) !== "node_modules") {
              const root = paths.join(directory, "node_modules", name);
              packagePath(root);
              const info = metadata(paths.join(root, "package.json"));
              if (info?.["exports"] !== undefined && info["exports"] !== null) {
                const result = mapped(root, info["exports"], subpath, kind, false, depth);
                if (result !== undefined) return result;
                break;
              }
              const path = paths.join(root, subpath);
              const result = kind === "require" || subpath === "." ? commonjs(path) : exact(path, kind);
              if (result !== undefined) return result;
            }
            if (directory === "/") break;
          }
          if ("profile" in dependencies && (kind === "require" || dependencies.runtime === "bun")) {
            for (const directory of dependencies.moduleSearchPaths) {
              const result = packageRoot(paths.join(directory, name), subpath, kind, depth);
              if (result !== undefined) return result;
            }
          }
        }
      }
    } else {
      const path = absolute(specifier, parent);
      admit(path);
      const result = kind === "require" ? commonjs(path) : exact(path, kind);
      if (result !== undefined) return result;
    }
    throw Object.assign(new Error(`Cannot find module '${specifier}' from '${parent}'`), {
      code: kind === "require" ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND",
    });
  }
  return {
    ...(loadNative === undefined ? {} : { loadNative }),
    ...(dependencies === undefined ? {} : { dependencies }),
    resolve,
    read(path) {
      admit(path);
      const text = source(path);
      if (path.endsWith(".json")) return { source: text, format: "json" };
      if (path.endsWith(".mjs")) return { source: text, format: "module" };
      if (path.endsWith(".cjs")) return { source: text, format: "commonjs" };
      for (let directory = paths.dirname(path); ; directory = paths.dirname(directory)) {
        if (paths.basename(directory) === "node_modules") return { source: text, format: "commonjs" };
        const info = metadata(`${directory === "/" ? "" : directory}/package.json`);
        if (info !== undefined) return { source: text, format: info["type"] === "module" ? "module" : "commonjs" };
        if (directory === "/") return { source: text, format: "commonjs" };
      }
    },
  };
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function invalidMetadata(path: string): Error {
  return Object.assign(new Error(`Invalid package config ${path}.`), { code: "ERR_INVALID_PACKAGE_CONFIG" });
}
function unsupported(path: string, reason: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", reason, { path, backend: "assisted-node" });
}
