import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const directory = resolve(repository, ".cache/documentation");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const guide = (await Promise.all(["docs/usage.md", "docs/images.md", "docs/wasm-modules.md"].map(path => readFile(resolve(repository, path), "utf8")))).join("\n");
const groups: { browser: string[]; node: string[] } = { browser: [], node: [] };
const seen = new Set<string>();
for (const match of guide.matchAll(/<!-- typecheck: ([^\n]+) -->\s*```ts\n([\s\S]*?)\n```/gu)) {
  const path = match[1]; const source = match[2];
  if (path === undefined || source === undefined || !/^(?:usage|images|wasm)\/[a-z.-]+\.ts$/u.test(path) || seen.has(path)) throw new Error("Invalid or duplicate documentation module");
  seen.add(path); const destination = resolve(directory, path);
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, source);
  groups[source.includes('from "@oxidevm/sdk/image-builder"') ? "node" : "browser"].push(path);
}
const expected = ["usage/main.ts", "usage/oxidevm.config.ts", "usage/persistence.ts", "usage/streams.ts", "usage/web-app.ts", "usage/short-command.ts", "usage/project-commands.ts", "usage/network.ts", "usage/terminal.ts", "usage/system.ts", "usage/resume.ts", "usage/python-recipe.ts", "usage/python.ts", "usage/system-recipe.ts", "usage/snapshot-recipe.ts", "usage/snapshot-prepare.ts", "usage/snapshot-verify.ts", "usage/snapshot-use.ts", "images/stage.ts", "wasm/define.ts", "wasm/use.ts"];
if (seen.size !== expected.length || expected.some(name => !seen.has(name))) throw new Error("Documentation modules differ from their named contract");
await mkdir(resolve(directory, "usage/generated"), { recursive: true });
// What `oxidevm wasm add` writes for the handles the module guide imports: the same call shape, with plausible pins.
const pins = (name: string): string => `{ release: "${"0".repeat(64)}", adapter: { url: "https://app.test/${name}/adapter.mjs", sha256: "${"1".repeat(64)}", bytes: 1 }, artifacts: {} }`;
const handle = (name: string, rest: string): string => `export const ${name} = moduleHandle({ schemaVersion: 1, id: "${name}", version: "1.0.0", abi: "raw", adapter: { api: 1, sha256: "${"1".repeat(64)}", bytes: 1 }, artifacts: [], ${rest}, license: { spdx: "MIT" } }, ${pins(name)});\n`;
await mkdir(resolve(directory, "wasm"), { recursive: true });
await writeFile(resolve(directory, "wasm/oxidevm.modules.generated.ts"), `import { moduleHandle } from "@oxidevm/sdk/wasm";\n${handle("database", `process: { kind: "service", exclusive: "workspace" }, expose: { sql: { kind: "unix", path: "/workspace/_oxidevm/database.sock", protocol: "oxidevm-sql/1" }, pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" } }, requires: { host: [] }, options: { dataDir: { type: "string", maxLength: 128 } }`)}${handle("wordfreq", `process: { kind: "command" }, requires: { host: ["files.sync"] }`)}`);
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
