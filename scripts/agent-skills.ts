import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exactKeys, record, string } from "../packages/sdk/src/runtime/decode.ts";

const repository = "https://github.com/spacia-ai/oxidevm-skills";
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const resource = /^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|agents\/openai\.yaml)$/u;

export function decodeSkillsPin(value: unknown) {
  const pin = record(value, "agent skills pin");
  exactKeys(pin, ["schemaVersion", "repository", "revision", "skillsVersion", "files"]);
  const revision = string(pin["revision"], "skills revision"), skillsVersion = string(pin["skillsVersion"], "skills version");
  if (pin["schemaVersion"] !== 1 || pin["repository"] !== repository || !/^[a-f0-9]{40}$/u.test(revision) || !version.test(skillsVersion)) throw new Error("Invalid agent skills source identity");
  const entries = pin["files"];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw new Error("Agent skill inventory must be bounded");
  const files = Array.from<unknown>(entries).map(value => {
    const file = record(value, "agent skill file"); exactKeys(file, ["path", "sha256"]);
    const path = string(file["path"], "agent skill path"), sha256 = string(file["sha256"], "agent skill hash");
    if (!resource.test(path) || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid agent skill path or hash");
    return { path, sha256 };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Agent skill inventory must be unique");
  for (const file of files) if (!files.some(entry => entry.path === `${file.path.split("/")[0] ?? ""}/SKILL.md`)) throw new Error("Agent resource has no SKILL.md");
  return { schemaVersion: 1 as const, repository, revision, skillsVersion, files };
}

/** One checked source produces both clients' discoverable files, including on Windows. */
export async function stageAgentSkills(root: string, sdkVersion: string): Promise<Record<string, string>> {
  if (!version.test(sdkVersion)) throw new Error("Invalid SDK version for bundled skills");
  const directory = join(root, "examples/starter"), snapshot = join(directory, ".agents/skills");
  const lock = join(directory, "agent-skills.lock.json"), metadata = await lstat(lock);
  if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("Agent skills pin must be a bounded regular file");
  const bytes = await readFile(lock);
  if (bytes.length > 64 * 1024) throw new Error("Agent skills pin exceeds its bound");
  const value: unknown = JSON.parse(bytes.toString("utf8")), pin = decodeSkillsPin(value);
  const actual: string[] = [];
  async function visit(path: string, prefix: string): Promise<void> {
    if (!(await lstat(path)).isDirectory()) throw new Error("Agent skill directory must be regular");
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.isDirectory()) await visit(join(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) actual.push(`${prefix}${entry.name}`);
      else throw new Error("Agent skill resources must be regular files");
    }
  }
  if (!(await lstat(join(directory, ".agents"))).isDirectory()) throw new Error("Agent skill parent must be regular");
  await visit(snapshot, "");
  if (JSON.stringify(actual.sort()) !== JSON.stringify(pin.files.map(file => file.path).sort())) throw new Error("Agent skill snapshot inventory differs from its pin");
  const output: Record<string, string> = {};
  for (const file of pin.files) {
    const path = join(snapshot, file.path), metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("Agent resource must be a bounded regular file");
    const data = await readFile(path);
    if (createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error("Agent skill content hash changed");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw new Error("Agent skill must be UTF-8 text");
    for (const client of [".agents", ".claude"]) output[`${client}/skills/${file.path}`] = text;
  }
  output["AGENT_SKILLS.json"] = `${JSON.stringify({ ...pin, sdkVersion }, null, 2)}\n`;
  return output;
}
