// Build the module frame (engine ADR 0028) into packages/sdk/assets/module-frame:
// - index.html: one document whose only script is the classic bootstrap, inline, so its CSP names it by sha256;
// - broker.js: the broker, one classic script (Chromium refuses module-type blob: workers in an opaque origin);
// - runner.js: the module runner (scripts/build-module-runner.ts), beside them, so one directory serves the frame;
// - frame.json: the bootstrap's sha256 and the response headers the whole directory must be served with.
// The opener reads broker.js and runner.js from its own origin and hands them to the frame as Blobs.
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { moduleFrameHeaders } from "../packages/sdk/asset-source/runtime-host/headers.ts";

const root = resolve(import.meta.dirname, ".."), sdk = resolve(root, "packages/sdk"), target = resolve(sdk, "assets/module-frame");

async function bundle(entry: string): Promise<string> {
  const result = await build({ entryPoints: [resolve(sdk, entry)], bundle: true, format: "iife", platform: "browser", target: "es2024", minify: true, legalComments: "none", sourcemap: false, write: false, logLevel: "warning", charset: "utf8" });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`esbuild produced nothing for ${entry}`);
  return output.text.trimEnd();
}

/** The frame document with `bootstrap` inline; the hash covers exactly the script element's text. */
export function moduleFrameDocument(bootstrap: string): { readonly html: string; readonly sha256: string } {
  if (bootstrap.includes("</script")) throw new Error("The module frame bootstrap cannot contain a closing script tag");
  return {
    html: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>OxideVM module frame</title></head><body><script>${bootstrap}</script></body></html>\n`,
    sha256: createHash("sha256").update(bootstrap, "utf8").digest("base64"),
  };
}

if (import.meta.main) {
  const document = moduleFrameDocument(await bundle("asset-source/module-frame/bootstrap.ts"));
  const broker = await bundle("src/runtime/workers/module-frame/broker.worker.ts");
  await mkdir(target, { recursive: true });
  await writeFile(resolve(target, "index.html"), document.html);
  await writeFile(resolve(target, "broker.js"), `${broker}\n`);
  await copyFile(resolve(sdk, "assets/module-runner/runner.worker.js"), resolve(target, "runner.js"));
  await writeFile(resolve(target, "frame.json"), `${JSON.stringify({ schemaVersion: 1, bootstrapSHA256: document.sha256, brokerSHA256: createHash("sha256").update(`${broker}\n`).digest("hex"), headers: moduleFrameHeaders(document.sha256) }, null, 2)}\n`);
  process.stdout.write(`${target}\n`);
}
