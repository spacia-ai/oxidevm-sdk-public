import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export interface AdditionalSourceInput { readonly url: string; readonly file: string; readonly sha256: string; readonly sha512: string; readonly format: "file" | "archive" }
export interface SourceInput { readonly name: string; readonly version: string; readonly url: string; readonly file: string; readonly sha256: string; readonly sha512: string; readonly aportsRevision: string; readonly scope: "guest" | "build-tool-source"; readonly origin?: string; readonly repository?: "main" | "community"; readonly format?: "archive" | "recipe"; readonly additional?: readonly AdditionalSourceInput[] }
interface AportsInput { readonly revision: string; readonly url: string; readonly file: string; readonly sha256: string }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => key in value), "Invalid source lock fields"); return value;
}
export function text(value: unknown): string { assert(typeof value === "string" && value.length > 0 && value.length < 8192 && !value.includes("\0"), "Invalid source lock text"); return value; }
function pin(value: unknown): string { const result = text(value); assert(/^[a-f0-9]{64}$/u.test(result), "Invalid source SHA-256"); return result; }
function filename(value: unknown): string { const result = text(value); assert(/^[A-Za-z0-9_.+-]+$/u.test(result) && ![".", ".."].includes(result), "Invalid source filename"); return result; }
function url(value: unknown): string { const result = text(value), parsed = new URL(result); assert(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "", "Source URLs require HTTPS"); return result; }
function revision(value: unknown): string { const result = text(value); assert(/^[a-f0-9]{40}$/u.test(result), "Source revision must be immutable"); return result; }
export function decodeSourceLock(value: unknown): { readonly sources: readonly SourceInput[]; readonly aports: readonly AportsInput[] } {
  const lock = fields(value, ["schemaVersion", "sources", "aports"]); assert((lock["schemaVersion"] === 1 || lock["schemaVersion"] === 2) && Array.isArray(lock["sources"]) && Array.isArray(lock["aports"]), "Invalid source lock version");
  const version = lock["schemaVersion"];
  const sources = Array.from<unknown>(lock["sources"]).map((value): SourceInput => {
    const item = fields(value, ["name", "version", "url", "file", "sha256", "sha512", "aportsRevision", "scope", ...(version === 2 ? ["origin", "repository", "format", "additional"] : [])]);
    const scope = item["scope"]; assert(scope === "guest" || scope === "build-tool-source", "Invalid source scope");
    const sha512 = text(item["sha512"]); assert(/^[a-f0-9]{128}$/u.test(sha512), "Invalid source SHA-512");
    const common: SourceInput = { name: filename(item["name"]), version: text(item["version"]), url: url(item["url"]), file: filename(item["file"]), sha256: pin(item["sha256"]), sha512, aportsRevision: revision(item["aportsRevision"]), scope };
    if (version === 1) return common;
    const repository = item["repository"], format = item["format"];
    assert(repository === "main" || repository === "community", "Invalid Alpine repository");
    assert(format === "archive" || format === "recipe", "Invalid Alpine source format");
    assert(Array.isArray(item["additional"]) && item["additional"].length <= 32, "Invalid additional source inputs");
    const additional = Array.from<unknown>(item["additional"]).map((value): AdditionalSourceInput => {
      const input = fields(value, ["url", "file", "sha256", "sha512", "format"]), extraFormat = input["format"], extraSHA512 = text(input["sha512"]);
      assert(extraFormat === "file" || extraFormat === "archive", "Invalid additional source format");
      assert(/^[a-f0-9]{128}$/u.test(extraSHA512), "Invalid additional source SHA-512");
      return { url: url(input["url"]), file: filename(input["file"]), sha256: pin(input["sha256"]), sha512: extraSHA512, format: extraFormat };
    });
    assert(new Set([common.file, ...additional.map(input => input.file)]).size === additional.length + 1, "Duplicate source files");
    return { ...common, origin: filename(item["origin"]), repository, format, additional };
  });
  const aports = Array.from<unknown>(lock["aports"]).map(value => { const item = fields(value, ["revision", "url", "file", "sha256"]); return { revision: revision(item["revision"]), url: url(item["url"]), file: filename(item["file"]), sha256: pin(item["sha256"]) }; });
  assert(sources.length > 0 && sources.length < 64 && new Set(sources.map(source => source.name)).size === sources.length && aports.length < 64, "Duplicate or excessive source pins");
  for (const source of sources) assert(aports.filter(port => port.revision === source.aportsRevision).length === 1, "Source lacks its exact Alpine recipe archive");
  return { sources, aports };
}

async function download(cache: string, input: { readonly url: string; readonly file: string; readonly sha256: string }): Promise<string> {
  await mkdir(cache, { recursive: true }); const path = join(cache, input.file);
  let bytes = await readFile(path).catch((error: unknown) => { if (isRecord(error) && error["code"] === "ENOENT") return undefined; throw error; });
  if (bytes === undefined) {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) }); assert(response.ok && response.body !== null, `Cannot fetch ${input.file}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; const chunk: unknown = next.value; assert(chunk instanceof Uint8Array && (size += chunk.length) < 128 * 1024 ** 2, "Source download exceeds limit"); chunks.push(chunk); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    bytes = Buffer.concat(chunks); assert(digest(bytes) === input.sha256, `Source changed: ${input.file}`); await writeFile(path, bytes, { flag: "wx" });
  }
  assert(digest(bytes) === input.sha256, `Cached source changed: ${input.file}`); return path;
}

export async function sourceMaterials(directory: string, cache: string, lock: ReturnType<typeof decodeSourceLock>): Promise<ReadonlyMap<string, { readonly source: string; readonly recipe: string; readonly upstream: string; readonly additional: readonly string[] }>> {
  const result = new Map<string, { readonly source: string; readonly recipe: string; readonly upstream: string; readonly additional: readonly string[] }>();
  for (const item of lock.sources) {
    const upstreamCache = join(cache, "upstream", ...(item.origin === undefined ? [] : [item.name]));
    const archive = await download(upstreamCache, item);
    assert(createHash("sha512").update(await readFile(archive)).digest("hex") === item.sha512, "Upstream source differs from Alpine checksum");
    const port = lock.aports.find(value => value.revision === item.aportsRevision); assert(port !== undefined);
    const portArchive = await download(join(cache, "aports"), port), recipe = join(directory, "recipes", item.aportsRevision);
    const source = join(directory, "upstream", item.name); await mkdir(source, { recursive: true }); await mkdir(recipe, { recursive: true });
    const origin = item.origin ?? item.name, repository = item.repository ?? "main", recipePath = join(recipe, repository, origin);
    await run("tar", ["-xzf", portArchive, "-C", recipe, "--strip-components=1", `aports-${item.aportsRevision}/${repository}/${origin}`], { timeout: 120_000 });
    const apkbuildBytes = await readFile(join(recipePath, "APKBUILD")), apkbuild = apkbuildBytes.toString();
    if (item.format === "recipe") {
      assert(apkbuildBytes.equals(await readFile(archive)), "Recipe-only source differs from its immutable Alpine tree");
      await cp(recipePath, source, { recursive: true });
    } else {
      assert(apkbuild.includes(`${item.sha512}  ${item.file}`), "Pinned source is absent from exact APKBUILD checksums");
      await run("tar", ["-xf", archive, "-C", source, "--strip-components=1", "--no-same-owner"], { timeout: 120_000 });
    }
    const additional: string[] = [];
    for (const input of item.additional ?? []) {
      const path = await download(upstreamCache, input), bytes = await readFile(path);
      assert(createHash("sha512").update(bytes).digest("hex") === input.sha512 && apkbuild.includes(`${input.sha512}  ${input.file}`), "Additional source differs from exact APKBUILD checksums");
      const destination = join(source, "additional", input.file); await mkdir(join(source, "additional"), { recursive: true });
      if (input.format === "file") await writeFile(destination, bytes);
      else { await mkdir(destination, { recursive: true }); await run("tar", ["-xf", path, "-C", destination, "--strip-components=1", "--no-same-owner"], { timeout: 120_000 }); }
      additional.push(path);
    }
    result.set(item.name, { source, recipe: recipePath, upstream: archive, additional });
    process.stdout.write(`Verified ${item.name} source and Alpine recipe\n`);
  }
  return result;
}

/** Preserve license files, embedded permission blocks and original copyright notices. */
export async function licenseNotices(root: string): Promise<string> {
  const sections: string[] = [], copyrights = new Set<string>(), headers = new Map<string, string[]>();
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = join(path, entry.name), relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(file, `${relative}/`);
      else if (entry.isFile() && !/\.(?:png|jpg|pdf|der|pem|key|bin|zip|gz|bz2|xz)$/iu.test(entry.name)) {
        if ((await lstat(file)).size > 2 * 1024 ** 2) continue;
        const bytes = await readFile(file); if (bytes.length > 2 * 1024 ** 2 || bytes.includes(0)) continue;
        const content = bytes.toString("utf8");
        if (/^(?:COPYING|COPYRIGHT|LICEN[CS]E|NOTICE)(?:[._-]|$)/iu.test(entry.name)) sections.push(`File: ${relative}\n${content}\n`);
        for (const line of content.split("\n")) if (/copyright.{0,20}(?:19|20)\d\d/iu.test(line)) copyrights.add(line.trim());
        if (/\.(?:c|cc|cpp|h|hpp|rs|js|ts|zig|go|s)$/iu.test(entry.name)) for (const match of content.matchAll(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*(?:\n|$))+/gmu)) {
          const notice = match[0].trim();
          if (!/copyright|SPDX-License-Identifier|public[ -]domain|permission (?:is hereby|to (?:use|copy))/iu.test(notice)) continue;
          const references = headers.get(notice) ?? []; references.push(relative); headers.set(notice, references);
        }
      }
    }
  }
  await visit(root, ""); assert(sections.length > 0 || headers.size > 0, `No upstream license text in ${root}`);
  const embedded = [...headers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([notice, files]) => `Files: ${files.join(", ")}\n${notice}`).join("\n\n");
  const result = `${sections.join("\n")}\nEmbedded upstream permission notices:\n${embedded}\n\nAdditional upstream copyright notices:\n${[...copyrights].sort().join("\n")}\n`;
  assert(Buffer.byteLength(result) < 2 * 1024 ** 2, "Component notices exceed the verified evidence bound"); return result;
}
