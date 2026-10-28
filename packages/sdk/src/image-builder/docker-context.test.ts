import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { stageDockerContext } from "./docker-context.js";

it("applies Dockerignore negations, freezes included inputs and excludes owned build output and locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-context-"));
  try {
    await mkdir(join(root, "context/dist"), { recursive: true }); await mkdir(join(root, "stage"));
    await writeFile(join(root, "context/Dockerfile"), "FROM scratch\nCOPY keep.txt /keep\n");
    await writeFile(join(root, "context/.dockerignore"), "*.txt\n!keep.txt\nauthor.pem\n");
    await writeFile(join(root, "context/keep.txt"), "included"); await writeFile(join(root, "context/ignored.txt"), "ignored");
    await writeFile(join(root, "context/author.pem"), "-----BEGIN PRIVATE KEY-----\nprivate\n");
    await writeFile(join(root, "context/image.lock.json"), "owned lock"); await writeFile(join(root, "context/dist/old"), "old result");
    const options = { recipeDir: join(root, "context"), signingKeyFile: "author.pem", outDir: "dist" };
    const input = await stageDockerContext({ kind: "dockerfile", context: ".", file: "Dockerfile" }, join(root, "stage"), options);
    expect(await readFile(join(input.context, "keep.txt"), "utf8")).toBe("included");
    for (const name of ["ignored.txt", "author.pem", "image.lock.json", "dist/old"]) await expect(readFile(join(input.context, name))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, "context/keep.txt"), "changed author input");
    expect(await readFile(join(input.context, "keep.txt"), "utf8")).toBe("included");
    expect(input.contextSHA256).toMatch(/^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(["author.pem", ".env", "copied-key"])("rejects credential input %s before invoking Docker", async name => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-context-secret-"));
  try {
    await mkdir(join(root, "context")); await mkdir(join(root, "stage"));
    await writeFile(join(root, "context/Dockerfile"), "FROM scratch\n");
    await writeFile(join(root, "context", name), "-----BEGIN PRIVATE KEY-----\nprivate\n");
    await expect(stageDockerContext({ kind: "dockerfile", context: ".", file: "Dockerfile" }, join(root, "stage"), { recipeDir: join(root, "context"), signingKeyFile: "author.pem" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("isolates Buildx local source cache identities for changed bytes with identical size and epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-context-cache-"));
  try {
    await mkdir(join(root, "context")); await mkdir(join(root, "first")); await mkdir(join(root, "second"));
    await writeFile(join(root, "context/Dockerfile"), "FROM scratch\nCOPY value /value\n");
    await writeFile(join(root, "context/value"), "one");
    const source = { kind: "dockerfile" as const, context: "context", file: "context/Dockerfile" };
    const options = { recipeDir: root, signingKeyFile: "author.pem" };
    const first = await stageDockerContext(source, join(root, "first"), options, 1);
    await writeFile(join(root, "context/value"), "two");
    const second = await stageDockerContext(source, join(root, "second"), options, 1);
    expect(first.contextSHA256).not.toBe(second.contextSHA256);
    // Buildx v0.31 uses the local context basename as its shared source key.
    expect(basename(first.context)).not.toBe(basename(second.context));
    expect(await readFile(join(first.context, "value"), "utf8")).toBe("one");
    expect(await readFile(join(second.context, "value"), "utf8")).toBe("two");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects a copied secret value before admitting a Docker context", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-context-secret-copy-"));
  try {
    await mkdir(join(root, "context")); await mkdir(join(root, "stage"));
    await writeFile(join(root, "context/Dockerfile"), "FROM scratch\nCOPY harmless-name /value\n");
    const privateValue = "private-registry-token-actual-fixture";
    await writeFile(join(root, "credential"), privateValue); await writeFile(join(root, "context/harmless-name"), `copied=${privateValue}`);
    await expect(stageDockerContext({ kind: "dockerfile", context: "context", file: "context/Dockerfile" }, join(root, "stage"),
      { recipeDir: root, signingKeyFile: "author.pem", secrets: [{ id: "registry", file: "credential" }] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains nested allowlisted inputs while excluding sibling directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-context-nested-"));
  try {
    await mkdir(join(root, "context/.cache/inputs"), { recursive: true });
    await mkdir(join(root, "context/.cache/materials")); await mkdir(join(root, "stage"));
    await writeFile(join(root, "context/Dockerfile"), "FROM scratch\nCOPY .cache/inputs/ /inputs/\n");
    await writeFile(join(root, "context/.dockerignore"), "*\n!Dockerfile\n!.cache/\n.cache/*\n!.cache/inputs/\n!.cache/inputs/**\n");
    await writeFile(join(root, "context/.cache/inputs/source"), "pinned input");
    await writeFile(join(root, "context/.cache/materials/secret"), "-----BEGIN PRIVATE KEY-----\nignored\n");
    const input = await stageDockerContext({ kind: "dockerfile", context: "context", file: "context/Dockerfile" }, join(root, "stage"), { recipeDir: root, signingKeyFile: "missing.pem" });
    expect(await readFile(join(input.context, ".cache/inputs/source"), "utf8")).toBe("pinned input");
    await expect(readFile(join(input.context, ".cache/materials/secret"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
