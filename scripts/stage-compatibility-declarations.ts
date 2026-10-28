import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../packages/sdk");
const owner = "runtime/workers/assistance";
const target = resolve(root, "dist", owner, "node-streams.d.ts");
const emitted = await readFile(target, "utf8");
const reference = '/// <reference path="./compatibility.d.ts" />\n';
if (!emitted.includes('from "readable-stream"')) throw new Error("Unexpected stream declaration owner");
await copyFile(resolve(root, "src", owner, "compatibility.d.ts"), resolve(root, "dist", owner, "compatibility.d.ts"));
if (!emitted.startsWith(reference)) await writeFile(target, reference + emitted);
