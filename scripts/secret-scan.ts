import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isEntryPoint } from "./entry-point.ts";

const version = "8.30.1";
const archiveSHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
const repository = resolve(import.meta.dirname, "..");

export function parseSecretScanArguments(args: readonly string[]): { readonly kind: "git" | "dir"; readonly directory: string } {
  const kind = args[0] ?? "git", directory = args[1] ?? ".";
  if (args.length > 2 || kind !== "git" && kind !== "dir" || directory.length === 0 || directory.length > 8192 || directory.startsWith("-") || directory.includes("\0")) throw new Error("usage: node scripts/secret-scan.ts [git|dir] [directory]");
  return { kind, directory };
}

async function scanner(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The pinned scanner currently requires Linux x64");
  const directory = join(repository, ".cache/tools", `gitleaks-${version}`), binary = join(directory, "gitleaks");
  if (await lstat(binary).catch(() => undefined) === undefined) {
    await mkdir(directory, { recursive: true });
    const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || response.body === null) throw new Error("Pinned secret scanner download failed");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new Error("Secret scanner download returned invalid bytes");
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024 ** 2) throw new Error("Secret scanner archive exceeds its size bound");
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const archive = Buffer.concat(chunks);
    assert.equal(createHash("sha256").update(archive).digest("hex"), archiveSHA256, "Secret scanner archive differs from its pin");
    const file = join(directory, "download.tgz");
    await writeFile(file, archive, { mode: 0o600 });
    try { execFileSync("tar", ["-xzf", file, "-C", directory, "gitleaks"], { timeout: 30_000 }); }
    finally { await rm(file, { force: true }); }
    await chmod(binary, 0o755);
    await writeFile(join(directory, "binary.sha256.installing"), createHash("sha256").update(await readFile(binary)).digest("hex"));
    await rename(join(directory, "binary.sha256.installing"), join(directory, "binary.sha256"));
  }
  assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"), await readFile(join(directory, "binary.sha256"), "utf8"), "Cached secret scanner was modified");
  assert.equal(execFileSync(binary, ["version"], { encoding: "utf8", timeout: 10_000 }).trim(), version);
  return binary;
}

export async function scanSecrets(directory: string, kind: "git" | "dir", configurationDirectory = directory): Promise<void> {
  const binary = await scanner();
  execFileSync(binary, [kind, "--no-banner", "--redact", "--config", join(configurationDirectory, ".gitleaks.toml"), directory], { cwd: directory, stdio: "inherit", timeout: 300_000 });
}

if (isEntryPoint(import.meta.url)) {
  const args = parseSecretScanArguments(process.argv.slice(2));
  await scanSecrets(resolve(args.directory), args.kind);
}
