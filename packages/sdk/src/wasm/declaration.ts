import { exactKeys, record, string } from "../runtime/decode.js";
import { byCodeUnit, canonicalBytes, decoding, GITHUB_OWNER, GITHUB_OWNER_OR_REPOSITORY, GITHUB_REPO, invalid, list, parseJSON, relativePath, text, unique } from "./decode-support.js";

export type ModuleSource =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly tag: string }
  | { readonly kind: "file"; readonly path: string };

export interface ModuleEntry {
  readonly id: string;
  /** `github:owner/repo@tag` or `file:relative/directory`. */
  readonly from: string;
}

/** `oxidevm.modules.json`: what the application asked for, never what it resolved to. */
export interface ModulesDeclaration {
  readonly schemaVersion: 1;
  /** GitHub owners (`acme`) or repositories (`acme/tool`) installed without a confirmation prompt. */
  readonly trusted: readonly string[];
  readonly modules: readonly ModuleEntry[];
}

export const MAX_DECLARATION_BYTES = 64 * 1024;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const MODULE_ID = /^[a-z][a-z0-9-]{0,62}$/u;

export function parseModuleSource(value: unknown, label = "source"): ModuleSource {
  const input = string(value, label);
  if (input.startsWith("file:")) {
    const path = input.slice(5);
    if (path.startsWith("/") || path.split("/").includes("..")) return invalid(label, "a file: source must be a directory inside the project, with no .. and no leading slash, so the lock works wherever the project is cloned; copy the release into the project (for example vendor/tool) and add file:vendor/tool");
    return { kind: "file", path: relativePath(path, `${label} path`) };
  }
  const match = /^github:([^/@]+)\/([^/@]+)@(.+)$/u.exec(input);
  if (match === null) return invalid(label, "must be github:owner/repo@tag or file:relative/directory");
  const [, owner, repo, tag] = match;
  return {
    kind: "github",
    owner: text(owner, `${label} owner`, GITHUB_OWNER, 39),
    repo: text(repo, `${label} repository`, GITHUB_REPO, 100),
    tag: text(tag, `${label} tag`, TAG, 128),
  };
}

export function formatModuleSource(source: ModuleSource): string {
  return source.kind === "file" ? `file:${source.path}` : `github:${source.owner}/${source.repo}@${source.tag}`;
}

/** True when the owner, or the exact repository, appears in the `trusted` list (GitHub names ignore case). */
export function isTrustedSource(trusted: readonly string[], source: ModuleSource): boolean {
  if (source.kind !== "github") return false;
  const owner = source.owner.toLowerCase(), repository = `${owner}/${source.repo.toLowerCase()}`;
  return trusted.some(entry => {
    const normalized = entry.toLowerCase();
    return normalized === owner || normalized === repository;
  });
}

export function decodeModulesDeclaration(value: unknown): ModulesDeclaration {
  return decoding("oxidevm.modules.json", () => {
    const input = record(value, "oxidevm.modules.json");
    exactKeys(input, ["schemaVersion", "trusted", "modules"]);
    if (input["schemaVersion"] !== 1) invalid("oxidevm.modules.json", "schemaVersion must be 1");
    const trusted = list(input["trusted"], "trusted", 64).map(entry => text(entry, "trusted entry", GITHUB_OWNER_OR_REPOSITORY, 140));
    unique(trusted.map(entry => entry.toLowerCase()), "trusted");
    const modules = list(input["modules"], "modules", 64).map((entry, index): ModuleEntry => {
      const item = record(entry, `modules[${String(index)}]`);
      exactKeys(item, ["id", "from"]);
      const from = string(item["from"], "module from");
      parseModuleSource(from, "module from");
      return { id: text(item["id"], "module id", MODULE_ID, 63), from };
    });
    unique(modules.map(module => module.id), "module ids");
    return {
      schemaVersion: 1,
      trusted: [...trusted].sort(byCodeUnit),
      modules: [...modules].sort((left, right) => byCodeUnit(left.id, right.id)),
    };
  });
}

/**
 * Reads the file a person edits: any JSON layout and entry order is accepted and normalised, because asking for
 * byte-exact formatting of a hand-edited file only produces errors. The tool writes it back with `encodeModulesDeclaration`,
 * so after its first write the file has the one canonical spelling. (The lock and the manifests, which only tools write
 * and whose bytes are hashed, stay strict.)
 */
export function decodeModulesDeclarationBytes(bytes: Uint8Array): ModulesDeclaration {
  return decoding("oxidevm.modules.json", () => decodeModulesDeclaration(parseJSON(bytes, "oxidevm.modules.json", MAX_DECLARATION_BYTES)));
}

export function encodeModulesDeclaration(declaration: ModulesDeclaration): Uint8Array<ArrayBuffer> {
  return canonicalBytes(decodeModulesDeclaration(declaration));
}
