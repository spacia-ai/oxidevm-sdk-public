import { readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { transform } from "esbuild";
import { minifyJavaScript } from "./production-javascript.ts";
import { isEntryPoint } from "./entry-point.ts";

/** Assemble fixed Linux programs before minifying them; framing fragments keep shared top-level names. */
export async function minifyGuestPrograms(directory: string): Promise<void> {
  const owner = join(directory, "runtime/workers/assistance");
  const programs = [["native-guest.js", "nativeGuestFrames"], ["node-brotli-guest.js", "brotliGuestSource"], ["node-tls-guest.js", "tlsGuestSource"], ["node-http2-guest.js", "http2GuestSource"]] as const;
  for (const [file, name] of programs) {
    const path = join(owner, file);
    try { await stat(path); } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const module: unknown = await import(pathToFileURL(path).href);
    if (typeof module !== "object" || module === null || !(name in module)) throw new Error(`${file} lacks its fixed program`);
    const program: unknown = Reflect.get(module, name);
    if (typeof program !== "string") throw new TypeError(`${name} must be a string`);
    const code = await readFile(path, "utf8"), source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let span: readonly [number, number] | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) span = [node.initializer.getStart(source), node.initializer.end];
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (span === undefined) throw new Error(`${file} changed its program declaration`);
    const minified = (await transform(program, { loader: "js", target: "es2024", ...(name === "nativeGuestFrames" ? {} : { format: "cjs" }), minify: true, legalComments: "eof" })).code;
    await writeFile(path, code.slice(0, span[0]) + JSON.stringify(minified) + code.slice(span[1]));
  }
}

/** The npm implementation files are compiled separately; declarations stay usable by consumers. */
export async function minifyDistribution(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await minifyDistribution(path);
    else if (entry.name.endsWith(".map")) await rm(path);
    else if (entry.name.endsWith(".js")) {
      await writeFile(path, await minifyJavaScript(await readFile(path, "utf8")));
      count++;
    } else if (entry.name.endsWith(".d.ts")) {
      await writeFile(path, (await readFile(path, "utf8")).replace(/^\/\/# sourceMappingURL=.*\r?\n?/gmu, ""));
    }
  }
  return count;
}

if (isEntryPoint(import.meta.url)) {
  const directory = process.argv[2];
  if (directory === undefined || process.argv.length !== 3) throw new Error("usage: node scripts/minify-distribution.ts <package dist directory>");
  const path = resolve(import.meta.dirname, "..", directory);
  await minifyGuestPrograms(path);
  console.log(`Minified ${String(await minifyDistribution(path))} JavaScript modules; source maps removed.`);
}
