import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exactKeys, record, string } from "../packages/sdk/src/runtime/decode.ts";
import { isEntryPoint } from "./entry-point.ts";

export interface RepositoryPolicy {
  readonly schemaVersion: 1 | 2;
  readonly files: readonly string[];
  readonly trees: readonly string[];
  readonly assets: Readonly<Record<string, { readonly sha256: string; readonly license: string }>>;
}

function plainPath(path: string): boolean {
  return path.length > 0 && path.length <= 8192 && !path.startsWith("/") && !path.includes("\\")
    && !Array.from(path).some(char => char.charCodeAt(0) < 32)
    && !path.split("/").some(part => part === ".." || part === "." || part === "");
}

export function decodeRepositoryPolicy(value: unknown): RepositoryPolicy {
  const input = record(value, "repository policy");
  const version = input["schemaVersion"];
  if (version !== 1 && version !== 2) throw new Error("Unsupported repository policy version");
  exactKeys(input, version === 1 ? ["schemaVersion", "files", "trees"] : ["schemaVersion", "files", "trees", "assets"]);
  function paths(key: "files" | "trees"): readonly string[] {
    const entries = input[key];
    if (!Array.isArray(entries) || entries.length > 4096) throw new Error(`${key} must be a bounded path list`);
    const decoded = Array.from<unknown>(entries).map(value => {
      const path = string(value, key);
      const trimmed = key === "trees" ? path.slice(0, -1) : path;
      if (!plainPath(trimmed) || key === "trees" && !path.endsWith("/")) throw new Error(`Invalid ${key} path: ${path}`);
      return path;
    });
    if (new Set(decoded).size !== decoded.length) throw new Error(`Duplicate ${key} path`);
    return decoded;
  }
  const files = paths("files"), trees = paths("trees");
  const assets: Record<string, { readonly sha256: string; readonly license: string }> = {};
  if (version === 2) for (const [path, entry] of Object.entries(record(input["assets"], "source assets"))) {
    const value = record(entry, "source asset"); exactKeys(value, ["sha256", "license"]);
    const sha256 = string(value["sha256"], "asset digest"), license = string(value["license"], "asset license");
    if (!plainPath(path) || !(path.endsWith(".woff2") || path === "examples/starter/public/favicon.png") || !files.includes(path) || !files.includes(license) || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Binary assets require an approved file, license and SHA-256");
    assets[path] = { sha256, license };
  }
  return { schemaVersion: version, files, trees, assets };
}

export function repositoryEntryError(policy: RepositoryPolicy, path: string, mode: string, target?: string): string | undefined {
  if (!plainPath(path)) return "invalid repository path";
  const segments = path.split("/");
  if (segments.some(part => [".git", "node_modules", "dist", ".cache", ".candidate", ".private", "coverage", "test-results", "playwright-report", ".gitkeep", ".DS_Store"].includes(part) || part === ".env" || part.startsWith(".env."))) return "local or generated artifact";
  if (/\.(?:wasm|img|qcow2|oxvm|tar|tgz|zip|pem|key|log)$/iu.test(path)) return "binary, credential or generated artifact";
  if (!policy.files.includes(path) && !policy.trees.some(prefix => path.startsWith(prefix))) return "outside the approved repository layout";
  if (path === "CLAUDE.md") return mode === "120000" && target === "AGENTS.md" ? undefined : "CLAUDE.md must be a relative symlink to AGENTS.md";
  if (path === "examples/starter/.claude/skills") return mode === "120000" && target === "../.agents/skills" ? undefined : "Starter Claude skills must link to the canonical project skills";
  if (mode !== "100644" && mode !== "100755") return "unexpected symlink or file mode";
  return undefined;
}

export function repositoryContentError(bytes: Uint8Array, maximumBytes = 16 * 1024 ** 2): string | undefined {
  if (bytes.byteLength > maximumBytes || bytes.includes(0)) return "binary or oversized source artifact";
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return "source artifacts must be UTF-8 text"; }
  return undefined;
}

/** Only reviewed fonts and the exact starter favicon can enter as binary source assets. */
export function repositoryFileContentError(policy: RepositoryPolicy, path: string, bytes: Uint8Array): string | undefined {
  const asset = policy.assets[path];
  if (asset === undefined) {
    const error = repositoryContentError(bytes);
    if (error !== undefined) return error;
    if (path.startsWith(".github/workflows/")) return "public repositories must not contain CI or publication workflows";
    return undefined;
  }
  if (path === "examples/starter/public/favicon.png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 33 || bytes.length > 64 * 1024
      || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      || view.getUint32(8) !== 13 || new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR"
      || view.getUint32(16) !== 96 || view.getUint32(20) !== 96
      || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return "favicon differs from its reviewed 96×96 PNG bytes";
    return undefined;
  }
  if (bytes.length < 48 || bytes.length > 256 * 1024 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "wOF2"
    || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== bytes.length
    || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return "font asset differs from its reviewed WOFF2 bytes";
  return undefined;
}

export async function readRepositoryPolicy(root: string): Promise<RepositoryPolicy> {
  const bytes = await readFile(join(root, "config/public-repository.json"));
  if (bytes.length > 256 * 1024) throw new Error("Repository policy exceeds its size bound");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return decodeRepositoryPolicy(value);
}

export async function checkRepositoryLayout(root: string): Promise<void> {
  const policy = await readRepositoryPolicy(root);
  const listed = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 ** 2, timeout: 30_000 });
  const failures: string[] = [];
  const paths = new Set<string>();
  for (const entry of listed.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t"), path = entry.slice(separator + 1), mode = entry.split(" ")[0];
    if (separator < 0 || mode === undefined) throw new Error("Invalid Git index entry");
    const initial = repositoryEntryError(policy, path, mode, mode === "120000" ? await readlink(join(root, path)) : undefined);
    if (initial !== undefined) { failures.push(`${path}: ${initial}`); continue; }
    paths.add(path);
    const file = join(root, path), metadata = await lstat(file);
    const error = metadata.isSymbolicLink()
      ? repositoryEntryError(policy, path, "120000", await readlink(file))
      : metadata.isFile() ? repositoryEntryError(policy, path, mode) : "tracked path is not a file";
    if (error !== undefined) failures.push(`${path}: ${error}`);
    if (metadata.isFile()) {
      const contentError = repositoryFileContentError(policy, path, await readFile(file));
      if (contentError !== undefined) failures.push(`${path}: ${contentError}`);
    }
  }
  for (const required of ["AGENTS.md", "CLAUDE.md", "LICENSE", "NOTICE"]) if (!paths.has(required)) failures.push(`${required}: required repository file is missing`);
  if (failures.length > 0) throw new Error(`Repository layout check failed:\n${failures.join("\n")}`);
}

if (isEntryPoint(import.meta.url)) {
  if (process.argv.length > 3) throw new Error("usage: node scripts/repository-layout.ts [directory]");
  await checkRepositoryLayout(resolve(process.argv[2] ?? "."));
  process.stdout.write("Repository layout and instruction symlink are valid.\n");
}
