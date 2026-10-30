import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageAgentSkills } from "./agent-skills.ts";

void test("a pinned skill snapshot stages both clients offline and binds the actual SDK version", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-agent-skills-"));
  try {
    const directory = join(root, "examples/starter"), content = "---\nname: oxidevm-sdk\ndescription: Use OxideVM.\n---\nUse installed declarations.\n";
    await mkdir(join(directory, ".agents/skills/oxidevm-sdk"), { recursive: true });
    const path = "oxidevm-sdk/SKILL.md", sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(join(directory, ".agents/skills", path), content);
    const pin = { schemaVersion: 1, repository: "https://github.com/spacia-ai/oxidevm-skills", revision: "a".repeat(40), skillsVersion: "0.0.4", files: [{ path, sha256 }] };
    const save = async (value: unknown) => writeFile(join(directory, "agent-skills.lock.json"), JSON.stringify(value));
    await save(pin);
    const files = await stageAgentSkills(root, "0.0.4");
    assert.equal(files[`.agents/skills/${path}`], content);
    assert.equal(files[`.claude/skills/${path}`], content);
    const manifest: unknown = JSON.parse(files["AGENT_SKILLS.json"] ?? "null");
    assert.deepEqual(manifest, { ...pin, sdkVersion: "0.0.4" });
    assert.deepEqual(await stageAgentSkills(root, "0.0.4"), files);
    await writeFile(join(directory, ".agents/skills", path), "changed");
    await assert.rejects(stageAgentSkills(root, "0.0.4"), /hash/u);
    await writeFile(join(directory, ".agents/skills", path), content);
    await save({ ...pin, files: [{ path: "../../.env", sha256 }] });
    await assert.rejects(stageAgentSkills(root, "0.0.4"), /path/u);
    await save(pin);
    await rm(join(directory, ".agents/skills", path));
    await symlink(join(directory, "agent-skills.lock.json"), join(directory, ".agents/skills", path));
    await assert.rejects(stageAgentSkills(root, "0.0.4"), /regular/u);
    assert((await readFile(join(directory, "agent-skills.lock.json"), "utf8")).includes(pin.revision));
  } finally { await rm(root, { recursive: true, force: true }); }
});
