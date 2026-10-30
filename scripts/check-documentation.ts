import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const directory = resolve(repository, ".cache/documentation");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const guide = (await Promise.all(["docs/usage.md", "docs/images.md"].map(path => readFile(resolve(repository, path), "utf8")))).join("\n");
const groups: { browser: string[]; node: string[] } = { browser: [], node: [] };
const seen = new Set<string>();
for (const match of guide.matchAll(/<!-- typecheck: ([^\n]+) -->\s*```ts\n([\s\S]*?)\n```/gu)) {
  const path = match[1]; const source = match[2];
  if (path === undefined || source === undefined || !/^(?:usage|images)\/[a-z.-]+\.ts$/u.test(path) || seen.has(path)) throw new Error("Invalid or duplicate documentation module");
  seen.add(path); const destination = resolve(directory, path);
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, source);
  groups[source.includes('from "@oxidevm/sdk/image-builder"') ? "node" : "browser"].push(path);
}
const expected = ["usage/main.ts", "usage/oxidevm.config.ts", "usage/persistence.ts", "usage/streams.ts", "usage/web-app.ts", "usage/short-command.ts", "usage/project-commands.ts", "usage/network.ts", "usage/terminal.ts", "usage/system.ts", "usage/resume.ts", "usage/python-recipe.ts", "usage/python.ts", "usage/system-recipe.ts", "usage/snapshot-recipe.ts", "usage/snapshot-prepare.ts", "usage/snapshot-verify.ts", "usage/snapshot-use.ts", "images/stage.ts"];
if (seen.size !== expected.length || expected.some(name => !seen.has(name))) throw new Error("Documentation modules differ from their named contract");
await mkdir(resolve(directory, "usage/generated"), { recursive: true });
// These declarations model a CLI-generated author reference; they are never shipped as image metadata.
const reference = 'import { defineImage } from "@oxidevm/sdk";\nexport default defineImage({mode:"userspace",manifestUrl:"/oxidevm/images/documentation-fixture/manifest.json",manifestSHA256:"' + "a".repeat(64) + '",trust:{algorithm:"Ed25519",keyId:"documentation-fixture",publicKey:"MCowBQYDK2VwAyEAmz+yeegiG5ZfqhtQl5/zfDQIy7mhqjC3H3G+sJEHYts="}});\n';
for (const name of ["python", "minimal"]) await writeFile(resolve(directory, `usage/generated/${name}.image.ts`), reference);
await writeFile(resolve(directory, "usage/image.ts"), reference);
for (const [environment, files] of Object.entries(groups)) {
  const config = { extends: "../../tsconfig.base.json", compilerOptions: { lib: environment === "browser" ? ["ES2024", "DOM", "DOM.Iterable"] : ["ES2024"], types: environment === "browser" ? [] : ["node"] }, files };
  const configPath = resolve(directory, `tsconfig.${environment}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2));
  execFileSync("pnpm", ["exec", "tsc", "-p", configPath], { cwd: repository, stdio: "inherit" });
}
process.stdout.write(`Compiled ${seen.size} documentation examples against actual SDK declarations in separate browser and Node graphs.\n`);
