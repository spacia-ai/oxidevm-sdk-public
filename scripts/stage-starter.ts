import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const paths = ["index.html", "vite.config.ts", "dev/preview-host.ts", "dev/runtime-assets.ts", "src/main.ts", "src/server.ts", "src/page.ts", "src/terminal.ts", "src/style.css", "README.md", "public/fonts/archivo.woff2", "public/fonts/roboto.woff2", "public/fonts/jetbrains-mono.woff2", "public/fonts/Archivo-OFL.txt", "public/fonts/Roboto-OFL.txt", "public/fonts/JetBrainsMono-OFL.txt", "public/fonts/README.md"];
const files: Record<string, string> = {};
for (const path of paths) {
  const bytes = await readFile(join(root, "examples/starter", path));
  files[path] = bytes.toString(path.endsWith(".woff2") ? "base64" : "utf8").replace("../../docs/licensing.md", "LICENSES.md");
}
await mkdir(join(root, "packages/cli/dist"), { recursive: true });
await writeFile(join(root, "packages/cli/dist/starter.json"), `${JSON.stringify(files)}\n`);
