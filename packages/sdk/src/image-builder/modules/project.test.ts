import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeModulesDeclaration } from "../../wasm/declaration.js";
import { BlobCache } from "./cache.js";
import { githubStub } from "./github.test-support.js";
import { commitAdd, DECLARATION_FILE, LOCK_FILE, loadModulesProject, previewAdd, readVendoredManifest, stageProject } from "./project.js";
import { buildReleaseFiles } from "./release.test-support.js";
import type { ResolveContext } from "./resolve.js";
import { STAGE_ROOT } from "./stage.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-project-")); directories.push(directory); return directory; }
const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const base = (host: readonly string[] = ["files.sync"], extra: Readonly<Record<string, unknown>> = {}) => buildReleaseFiles({ id: "tool", artifacts: { "tool.wasm": wasm }, host, extra });

async function project(trusted: readonly string[] = []): Promise<{ readonly dir: string; context(stub: ReturnType<typeof githubStub>, offline?: boolean): ResolveContext }> {
  const dir = await temporary(), cache = new BlobCache(await temporary());
  await writeFile(join(dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted, modules: [] }));
  return { dir, context: (stub, offline = false) => ({ projectDir: dir, cache, fetchImpl: stub.fetchImpl, offline }) };
}
const source = "github:acme/tool-module@v1.0.0";

describe("previewing an add", () => {
  it("asks about a source nobody trusts and not about one the project trusts", async () => {
    const stub = githubStub(base());
    const untrusted = await project(), trusted = await project(["acme"]);
    expect((await previewAdd(untrusted.dir, source, untrusted.context(stub))).consent).toEqual({ required: true, reasons: ["untrusted-source"], otherwise: "none-needed" });
    expect((await previewAdd(trusted.dir, source, trusted.context(stub))).consent).toEqual({ required: false, reasons: [], otherwise: "trusted-source" });
  });

  it("writes nothing", async () => {
    const stub = githubStub(base()), p = await project();
    await previewAdd(p.dir, source, p.context(stub));
    expect(await readdir(p.dir)).toEqual([DECLARATION_FILE]);
  });
});

describe("recording an add", () => {
  it("writes the declaration, lock, committed module.json, staged files and generated handles", async () => {
    const release = base(), stub = githubStub(release), p = await project();
    const preview = await previewAdd(p.dir, source, p.context(stub));
    const added = await commitAdd(p.dir, preview, p.context(stub));
    expect(added).toMatchObject({ id: "tool", status: "added" });
    const loaded = await loadModulesProject(p.dir);
    expect(loaded.declaration.modules).toEqual([{ id: "tool", from: source }]);
    expect(loaded.lock.modules["tool"]).toMatchObject({ version: "1.0.0", release: preview.card.release, capabilities: ["files.sync"], source: { kind: "github", repository: "acme/tool-module", tag: "v1.0.0" } });
    expect(await readVendoredManifest(p.dir, "tool")).toEqual(release.manifest);
    expect((await readdir(join(p.dir, STAGE_ROOT, "tool", preview.card.release))).sort()).toEqual(["SHA256SUMS", "adapter.mjs", "adapter.mjs.bin", "module.json", "tool.wasm"]);
    expect(await readFile(join(p.dir, "src/oxidevm.modules.generated.ts"), "utf8")).toContain("export const tool = moduleHandle(");
    expect(await readFile(join(p.dir, LOCK_FILE), "utf8")).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it("reports the same release added again as unchanged and asks nothing", async () => {
    const stub = githubStub(base()), p = await project();
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(stub)), p.context(stub));
    const again = await previewAdd(p.dir, source, p.context(stub));
    expect(again).toMatchObject({ status: "unchanged", added: [], removed: [], consent: { required: false } });
  });

  it("keeps the declaration sorted when several modules are added", async () => {
    const p = await project(["acme"]);
    for (const id of ["zeta", "alpha"]) {
      const stub = githubStub(buildReleaseFiles({ id }), { repo: id, tag: "v1.0.0" });
      await commitAdd(p.dir, await previewAdd(p.dir, `github:acme/${id}@v1.0.0`, p.context(stub)), p.context(stub));
    }
    expect((await loadModulesProject(p.dir)).declaration.modules.map(entry => entry.id)).toEqual(["alpha", "zeta"]);
    const text = await readFile(join(p.dir, DECLARATION_FILE), "utf8");
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
  });
});

describe("updating an installed module", () => {
  async function installed(trusted: readonly string[]) {
    const p = await project(trusted), first = githubStub(base());
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(first)), p.context(first));
    return p;
  }

  it("asks again when a release asks for more, even from a trusted source", async () => {
    const p = await installed(["acme"]);
    const wider = githubStub(base(["files.sync", "process.spawn"]), { tag: "v1.1.0" });
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v1.1.0", p.context(wider));
    expect(preview).toMatchObject({ status: "updated", added: ["host:process.spawn"], removed: [], consent: { required: true, reasons: ["authority-widened"] } });
  });

  it("does not ask when a release asks for less or the same", async () => {
    const p = await project(), first = githubStub(base(["files.sync", "process.spawn"]));
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(first)), p.context(first));
    const narrower = githubStub(base(["files.sync"]), { tag: "v1.1.0" });
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v1.1.0", p.context(narrower));
    expect(preview).toMatchObject({ status: "updated", added: [], removed: ["host:process.spawn"], consent: { required: false } });
  });

  it("treats another publisher under the same id as new, unless that publisher is trusted", async () => {
    const p = await installed(["acme"]);
    const other = githubStub(base(), { owner: "mallory", repo: "tool-module" });
    expect((await previewAdd(p.dir, "github:mallory/tool-module@v1.0.0", p.context(other))).consent).toMatchObject({ required: true, reasons: ["untrusted-source"] });
  });
});

describe("staging a project from its lock", () => {
  it("rebuilds the staged files from the cache with the network off", async () => {
    const stub = githubStub(base()), p = await project();
    const preview = await previewAdd(p.dir, source, p.context(stub));
    await commitAdd(p.dir, preview, p.context(stub));
    await rm(join(p.dir, STAGE_ROOT), { recursive: true });
    const offline = githubStub(base());
    const result = await stageProject(p.dir, p.context(offline, true));
    expect(result.staged).toMatchObject([{ id: "tool", release: preview.card.release, rebuilt: true }]);
    expect(offline.calls).toEqual([]);
  });

  it("refuses a declaration and lock that disagree, naming the module", async () => {
    const p = await project();
    await writeFile(join(p.dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted: [], modules: [{ id: "tool", from: source }] }));
    await expect(stageProject(p.dir, p.context(githubStub(base())))).rejects.toThrow(/tool is declared .* but not locked/u);
  });

  it("refuses a lock entry that no declaration asks for", async () => {
    const stub = githubStub(base()), p = await project();
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(stub)), p.context(stub));
    await writeFile(join(p.dir, DECLARATION_FILE), encodeModulesDeclaration({ schemaVersion: 1, trusted: [], modules: [] }));
    await expect(stageProject(p.dir, p.context(stub))).rejects.toThrow(/tool is locked but not declared/u);
  });
});

describe("an add that cannot be staged", () => {
  it("writes neither the lock nor the declaration, so the next stage is not poisoned", async () => {
    const stub = githubStub(base()), p = await project();
    // An author's own file where the generated handles would go: staging must refuse to overwrite it.
    await mkdir(join(p.dir, "src"), { recursive: true });
    await writeFile(join(p.dir, "src/oxidevm.modules.generated.ts"), "export const mine = 1;\n");
    const declaration = await readFile(join(p.dir, DECLARATION_FILE));
    const preview = await previewAdd(p.dir, source, p.context(stub));
    await expect(commitAdd(p.dir, preview, p.context(stub))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await readdir(p.dir)).sort()).toEqual([DECLARATION_FILE, "src"]);
    expect(await readFile(join(p.dir, DECLARATION_FILE))).toEqual(declaration);
    expect(await readFile(join(p.dir, "src/oxidevm.modules.generated.ts"), "utf8")).toBe("export const mine = 1;\n");
  });

  it("refuses a second module whose JavaScript name collides with an installed one, and leaves the project as it was", async () => {
    const first = githubStub(buildReleaseFiles({ id: "a-1", artifacts: { "tool.wasm": wasm }, host: ["files.sync"] }), { repo: "a-1" }), p = await project();
    await commitAdd(p.dir, await previewAdd(p.dir, "github:acme/a-1@v1.0.0", p.context(first)), p.context(first));
    const lock = await readFile(join(p.dir, LOCK_FILE)), declaration = await readFile(join(p.dir, DECLARATION_FILE)), generated = await readFile(join(p.dir, "src/oxidevm.modules.generated.ts"));
    const second = githubStub(buildReleaseFiles({ id: "a1", artifacts: { "tool.wasm": wasm }, host: ["files.sync"] }), { repo: "a1" });
    await expect(commitAdd(p.dir, await previewAdd(p.dir, "github:acme/a1@v1.0.0", p.context(second)), p.context(second))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(join(p.dir, LOCK_FILE))).toEqual(lock);
    expect(await readFile(join(p.dir, DECLARATION_FILE))).toEqual(declaration);
    expect(await readFile(join(p.dir, "src/oxidevm.modules.generated.ts"))).toEqual(generated);
    // Nothing of the refused module reached the project, not even its committed manifest or its staged files.
    expect((await readdir(join(p.dir, "modules"))).sort()).toEqual(["a-1"]);
    expect((await readdir(join(p.dir, STAGE_ROOT))).sort()).toEqual(["a-1"]);
    expect((await stageProject(p.dir, p.context(first))).staged.map(entry => entry.id)).toEqual(["a-1"]);
  });
});

describe("what an add may rely on", () => {
  it("counts the committed module.json as the installed release only when it is the file the lock pins", async () => {
    const first = githubStub(base(["files.sync"]), { tag: "v1.0.0" }), p = await project(["acme"]);
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(first)), p.context(first));
    // A pull request replaces the committed copy with one that already asks for everything the next release will ask for.
    const wide = base(["files.sync", "process.spawn"], { version: "2.0.0" });
    await writeFile(join(p.dir, "modules", "tool", "module.json"), wide.manifestBytes);
    const second = githubStub(wide, { tag: "v2.0.0" });
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v2.0.0", p.context(second));
    expect(preview.consent).toMatchObject({ required: true, reasons: ["authority-widened"] });
    expect(preview.added).toContain("host:process.spawn");
  });

  it("still compares with the committed module.json when it is the file the lock pins", async () => {
    const first = githubStub(base(["files.sync"]), { tag: "v1.0.0" }), p = await project(["acme"]);
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(first)), p.context(first));
    const narrower = base(["files.sync"], { version: "1.0.1" });
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v1.0.1", p.context(githubStub(narrower, { tag: "v1.0.1" })));
    expect(preview.consent).toMatchObject({ required: false });
    expect(preview.added).toEqual([]);
  });

  it("asks again about a new release when no committed copy can show what was agreed to, even if the release asks for no authority at all", async () => {
    const first = githubStub(base([]), { tag: "v1.0.0" }), p = await project(["acme"]);
    await commitAdd(p.dir, await previewAdd(p.dir, source, p.context(first)), p.context(first));
    await rm(join(p.dir, "modules", "tool", "module.json"));
    const next = githubStub(base([], { version: "1.0.1" }), { tag: "v1.0.1" });
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v1.0.1", p.context(next));
    expect(preview.consent).toMatchObject({ required: true, reasons: ["authority-widened"] });
  });

  it("refuses a copyleft release that names no source before anyone is asked", async () => {
    const p = await project(["acme"]);
    await expect(previewAdd(p.dir, source, p.context(githubStub(base(["files.sync"], { license: { spdx: "GPL-3.0-only" } }))))).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    const named = base(["files.sync"], { license: { spdx: "GPL-3.0-only", source: "https://example.com/tool-src" } });
    expect((await previewAdd(p.dir, source, p.context(githubStub(named)))).card.license).toMatchObject({ copyleft: true });
  });

  it("refuses a module id that cannot be a JavaScript name before anyone is asked, and installs an id that names a plain-object method", async () => {
    const p = await project(["acme"]);
    for (const id of ["eval", "arguments", "class"]) {
      const release = buildReleaseFiles({ id, artifacts: { "tool.wasm": wasm }, host: ["files.sync"] });
      await expect(previewAdd(p.dir, "github:acme/tool-module@v1.0.0", p.context(githubStub(release))), id).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    const release = buildReleaseFiles({ id: "constructor", artifacts: { "tool.wasm": wasm }, host: ["files.sync"] });
    const stub = githubStub(release);
    const preview = await previewAdd(p.dir, "github:acme/tool-module@v1.0.0", p.context(stub));
    expect(preview.status).toBe("added");
    await commitAdd(p.dir, preview, p.context(stub));
    expect((await previewAdd(p.dir, "github:acme/tool-module@v1.0.0", p.context(stub))).status).toBe("unchanged");
  });
});
