import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stageAgentSkills } from "./agent-skills.ts";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";
import { isEntryPoint } from "./entry-point.ts";

export async function stageStarter(root: string): Promise<void> {
  const paths = ["index.html", "vite.config.ts", "dev/preview-host.ts", "dev/runtime-assets.ts", "src/main.ts", "src/python.ts", "src/editor.ts", "src/analysis.ts", "src/dataframe.ts", "src/terminal.ts", "src/style.css", "README.md", "public/favicon.png", "public/licenses/highlight.js.txt", "public/fonts/archivo.woff2", "public/fonts/roboto.woff2", "public/fonts/jetbrains-mono.woff2", "public/fonts/Archivo-OFL.txt", "public/fonts/Roboto-OFL.txt", "public/fonts/JetBrainsMono-OFL.txt", "public/fonts/README.md"];
  const files: Record<string, string> = {};
  paths.push("src/agent-skills.ts");
  const sdk: unknown = JSON.parse(await readFile(join(root, "packages/sdk/package.json"), "utf8"));
  const version = string(record(sdk, "SDK package")["version"], "SDK version");
  Object.assign(files, await stageAgentSkills(root, version));
  const release = "https://github.com/spacia-ai/oxidevm-sdk-public";
  for (const path of paths) {
    const bytes = await readFile(join(root, "examples/starter", path));
    files[path] = bytes.toString((path.endsWith(".woff2") || path.endsWith(".png")) ? "base64" : "utf8")
      .replaceAll("../../docs/licensing.md", "LICENSES.md")
      .replace("../../docs/agent-skills.md", `${release}/blob/v${version}/docs/agent-skills.md`)
      .replace("../../docs/images.md", `${release}/blob/v${version}/docs/images.md`)
      .replace("](image/)", `](${release}/tree/v${version}/examples/starter/image)`);
  }
  await mkdir(join(root, "packages/cli/dist"), { recursive: true });
  await writeFile(join(root, "packages/cli/dist/starter.json"), `${JSON.stringify(files)}\n`);
}

if (isEntryPoint(import.meta.url)) await stageStarter(resolve(import.meta.dirname, ".."));
