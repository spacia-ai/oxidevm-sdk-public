import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VMError } from "@oxidevm/sdk";
import { object } from "./validation.js";
import { file } from "./template-files.js";

export async function archiveDependencies(archives: { readonly sdk: string; readonly cli: string } | undefined): Promise<{ readonly sdk: string; readonly cli: string } | undefined> {
  if (archives === undefined) return undefined;
  for (const path of [archives.sdk, archives.cli]) {
    const metadata = await lstat(path).catch(() => undefined);
    if (metadata?.isFile() !== true || !path.endsWith(".tgz") || metadata.size > 256 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "Package archives must be regular .tgz files of at most 256 MiB");
  }
  return { sdk: `file:${resolve(archives.sdk)}`, cli: `file:${resolve(archives.cli)}` };
}

/** The build stages the canonical example once; scaffolding never maintains a second copy. */
export async function writeStarter(directory: string): Promise<void> {
  const template = object(JSON.parse(await readFile(new URL("../dist/starter.json", import.meta.url), "utf8")), "starter template");
  if (Object.keys(template).length > 64) throw new VMError("PROTOCOL_ERROR", "Starter template exceeds its file limit");
  for (const [path, content] of Object.entries(template)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/u.test(path) || path.split("/").some(part => part === ".." || part === "." || part === "")) throw new VMError("PROTOCOL_ERROR", "Starter template contains an escaping path");
    if (typeof content !== "string" || content.length > 1024 ** 2) throw new VMError("PROTOCOL_ERROR", "Starter template file exceeds its limit");
    const value = content;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    if (path.endsWith(".woff2") || path.endsWith(".png")) await writeFile(join(directory, path), Buffer.from(value, "base64"), { flag: "wx" });
    else await file(directory, path, value);
  }
  await file(directory, "tsconfig.node.json", `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { lib: ["ES2024"], types: ["node"] }, include: ["vite.config.ts", "dev/**/*.ts", "oxidevm.config.ts"] }, null, 2)}\n`);
}
