// Bundle the module runner into the single classic worker file every module process starts (ADR 0028: the module
// frame runs it as a classic blob: worker, which Chromium requires in an opaque origin). The result is SDK code only:
// it carries no module, no artifact and no adapter, which are fetched, verified and imported at run time.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const entry = resolve(root, "packages/sdk/asset-source/module-runner/entry.ts");
const target = resolve(root, "packages/sdk/assets/module-runner/runner.worker.js");
await mkdir(dirname(target), { recursive: true });
await build({ entryPoints: [entry], outfile: target, bundle: true, format: "iife", platform: "browser", target: "es2024", minify: true, legalComments: "none", sourcemap: false, logLevel: "warning" });
const worker = await readFile(target);
const provenance = { schemaVersion: 1, workerSHA256: createHash("sha256").update(worker).digest("hex"), bytes: worker.byteLength, entry: "packages/sdk/asset-source/module-runner/entry.ts" };
await writeFile(`${target}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(`${target}\n`);
