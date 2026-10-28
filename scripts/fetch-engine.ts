// Stages the SDK's pinned engine release at .cache/engine/current, where core tests and local
// tools read it through OXIDEVM_ENGINE_DIR. The release comes from OXIDEVM_ENGINE_DIR, the local
// engine cache, or a download of the private release with OXIDEVM_DOWNLOAD_TOKEN or GH_TOKEN.
//
// usage: pnpm engine:fetch [--print-dir]   (--print-dir prints only the directory, for $(...))
import { join, resolve } from "node:path";
import { copyEngineRelease, pinnedEngineRelease, resolveEngineDirectory } from "../packages/sdk/dist/image-builder/engine-source.js";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--print-dir")) throw new Error("usage: pnpm engine:fetch [--print-dir]");
const target = join(root, ".cache/engine/current");
const pin = pinnedEngineRelease();
const source = await resolveEngineDirectory({}, pin);
if (source !== target) await copyEngineRelease(source, target, pin);
process.stdout.write(args[0] === "--print-dir" ? `${target}\n` : `Engine release ${pin.id} is staged at ${target} (from ${source}).\n`);
