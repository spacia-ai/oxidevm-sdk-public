import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import type { RequestListener } from "node:http";
import { createServer as httpsServer } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { qualificationCommand } from "./qualification-command.ts";

export function qualificationHttpsDirectory(): string | undefined {
  const directory = process.env["OXIDEVM_HTTPS_DIRECTORY"];
  if (directory === undefined) return undefined;
  const privateRoot = resolve(import.meta.dirname, "../.private/qualification-https");
  if (!isAbsolute(directory) || resolve(directory) !== privateRoot) throw new Error("Use the private local qualification certificate directory");
  return directory;
}
export async function qualificationServer(listener: RequestListener) {
  const directory = qualificationHttpsDirectory();
  return directory === undefined ? httpServer(listener) : httpsServer({ key: await readFile(join(directory, "server.key")), cert: await readFile(join(directory, "server.crt")) }, listener);
}
async function execute(command: string, args: readonly string[]): Promise<void> {
  const result = await qualificationCommand(command, args, { cwd: resolve(import.meta.dirname, ".."), timeoutMs: 30_000 });
  if (result.exitCode !== 0 || result.signal !== null || result.failure !== null) throw new Error(`Certificate trust installation failed: ${command}\n${result.stderr}`);
}
export async function trustQualificationHttpsSystem(): Promise<void> {
  const directory = qualificationHttpsDirectory(); if (directory === undefined) return;
  // This changes only the ephemeral qualification container's trust stores.
  if (process.env["OXIDEVM_QUALIFICATION_CONTAINER_ID"] === undefined) throw new Error("Install local CA trust only inside the qualification container");
  await copyFile(join(directory, "ca.crt"), "/usr/local/share/ca-certificates/oxidevm-qualification.crt", constants.COPYFILE_EXCL);
  await execute("update-ca-certificates", []);
  await trustQualificationHttpsBrowser("chromium", join(homedir(), ".pki/nssdb"));
}
export async function trustQualificationHttpsBrowser(browser: string, profile: string): Promise<void> {
  const directory = qualificationHttpsDirectory(); if (directory === undefined || browser === "webkit") return;
  await mkdir(profile, { recursive: true });
  await execute("certutil", ["-N", "--empty-password", "-d", `sql:${profile}`]);
  await execute("certutil", ["-A", "-a", "-n", "OxideVM qualification CA", "-t", "C,,", "-d", `sql:${profile}`, "-i", join(directory, "ca.crt")]);
}
