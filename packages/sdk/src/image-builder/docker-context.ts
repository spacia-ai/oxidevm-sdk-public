import ignore from "@balena/dockerignore";
import { chmod, mkdir, lstat, readlink, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VMError } from "../runtime/errors.js";
import type { BuildImageOptions, RootfsSource } from "./contracts.js";
import { assertNoBuildSecrets, hash, readSourceFile } from "./files.js";
import { abortIfRequested } from "./tools.js";
import { loadBuildSecrets } from "./build-secrets.js";
import type { LoadedBuildSecrets } from "./build-secrets.js";

export interface StagedDockerContext {
  readonly context: string; readonly dockerfile: string;
  readonly contextSHA256: string; readonly dockerfileSHA256: string;
}
function contains(parent: string, path: string): boolean {
  const offset = relative(parent, path); return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/** Freeze exactly the admitted context before Docker reads it; private inputs never enter that context. */
export async function stageDockerContext(source: Extract<RootfsSource, { readonly kind: "dockerfile" }>, staging: string, options: BuildImageOptions, epoch = 0, secrets?: LoadedBuildSecrets): Promise<StagedDockerContext> {
  const forbidden = (secrets ?? await loadBuildSecrets(options)).forbidden;
  const root = resolve(options.recipeDir, source.context); const originalDockerfile = resolve(options.recipeDir, source.file);
  const context = join(staging, "docker-context"); const dockerfile = join(staging, "dockerfile", "Dockerfile");
  const protectedPaths = [resolve(options.recipeDir, options.signingKeyFile), ...(options.secrets ?? []).map(secret => resolve(options.recipeDir, secret.file))];
  const out = resolve(options.recipeDir, options.outDir ?? "dist");
  const ownedLock = resolve(options.recipeDir, "image.lock.json");
  const specific = `${originalDockerfile}.dockerignore`;
  const ignorePath = await lstat(specific).then(() => specific).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return join(root, ".dockerignore");
    throw error;
  });
  let patterns = "";
  try { patterns = new TextDecoder("utf-8", { fatal: true }).decode((await readSourceFile(ignorePath, 1024 ** 2, options.signal)).bytes); }
  catch (error) {
    const exists = await lstat(ignorePath).then(() => true).catch((cause: unknown) => {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return false;
      throw cause;
    });
    if (exists) throw error;
  }
  const matcher = ignore({ ignorecase: false }).add(patterns);
  const collected: [string, string, number, string][] = [];
  let entries = 0; let total = 0;
  await mkdir(context); await mkdir(dirname(dockerfile));
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 64) throw new VMError("INVALID_ARGUMENT", "Docker context exceeds its directory depth bound");
    for (const name of await readdir(join(root, directory))) {
      abortIfRequested(options.signal);
      const path = directory === "" ? name : `${directory}/${name}`; const absolute = join(root, path);
      if (absolute === ownedLock || absolute === resolve(options.recipeDir, ".oxidevm-image-build.lock") || name.startsWith(".image-lock-") || contains(out, absolute)) continue;
      const metadata = await lstat(absolute); const isDirectory = metadata.isDirectory();
      if (matcher.ignores(path)) continue;
      assertNoBuildSecrets(Buffer.from(path), forbidden);
      entries++; if (entries > 65536) throw new VMError("INVALID_ARGUMENT", "Docker context exceeds its entry bound");
      if (protectedPaths.includes(absolute) || path.split("/").some(part => [".git", ".ssh", ".aws"].includes(part)) || /^\.env(?:\.[^.]+)?$/u.test(name) && ![".env.example", ".env.sample"].includes(name)) {
        throw new VMError("INVALID_ARGUMENT", "exclude private keys, secrets and credential files with Dockerignore before building", { path });
      }
      const target = join(context, path); const mode = metadata.mode & 0o7777;
      if (isDirectory) { await mkdir(target, { recursive: true, mode: 0o700 }); collected.push([path, "directory", mode, ""]); await walk(path, depth + 1); await chmod(target, mode); await utimes(target, epoch, epoch); }
      else if (metadata.isFile()) {
        const read = await readSourceFile(absolute, 128 * 1024 ** 2, options.signal);
        assertNoBuildSecrets(read.bytes, forbidden);
        if (read.dev !== metadata.dev || read.ino !== metadata.ino) throw new VMError("PROTOCOL_ERROR", "Docker context entry changed while staging");
        if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(Buffer.from(read.bytes).toString("latin1"))) throw new VMError("INVALID_ARGUMENT", "Docker context contains a private key", { path });
        total += read.bytes.length; if (total > 4 * 1024 ** 3) throw new VMError("INVALID_ARGUMENT", "Docker context exceeds its byte bound");
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, read.bytes, { flag: "wx", mode: read.mode });
        await chmod(target, read.mode);
        await utimes(target, epoch, epoch);
        collected.push([path, "file", read.mode, hash(read.bytes)]);
      } else if (metadata.isSymbolicLink()) {
        const link = await readlink(absolute);
        if (isAbsolute(link) || !contains(root, resolve(dirname(absolute), link))) throw new VMError("INVALID_ARGUMENT", "Docker context link leaves its root", { path });
        await mkdir(dirname(target), { recursive: true }); await symlink(link, target); collected.push([path, "symlink", mode, hash(link)]);
      } else throw new VMError("INVALID_ARGUMENT", "Docker context contains an unsupported special file", { path });
    }
  }
  await walk("", 0);
  const bytes = (await readSourceFile(originalDockerfile, 1024 ** 2, options.signal)).bytes;
  assertNoBuildSecrets(bytes, forbidden);
  await writeFile(dockerfile, bytes, { flag: "wx" });
  await utimes(dockerfile, epoch, epoch);
  if (patterns !== "") await writeFile(`${dockerfile}.dockerignore`, patterns, { flag: "wx" });
  await utimes(context, epoch, epoch);
  const sorted = collected.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const contextSHA256 = hash(JSON.stringify(sorted)); const dockerfileSHA256 = hash(bytes);
  // Buildx uses the context basename as its shared local-source cache key. Fixed
  // epochs and equal-sized changed files must never reuse another input's key.
  const ownedContext = join(staging, `docker-context-${hash(JSON.stringify([contextSHA256, dockerfileSHA256]))}`);
  await rename(context, ownedContext);
  return { context: ownedContext, dockerfile, contextSHA256, dockerfileSHA256 };
}
