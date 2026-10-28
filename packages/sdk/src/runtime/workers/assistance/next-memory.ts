import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { File } from "@babel/types";
import { VMError } from "../../errors.ts";
import { traverseModule } from "./module-syntax.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import { NEXT_MEMORY_EXCEPTION } from "../../assistance-artifacts.ts";
export { NEXT_MEMORY_EXCEPTION } from "../../assistance-artifacts.ts";

const sources: Readonly<Record<string, { readonly hash: string; readonly edits: number }>> = {
  "dist/cli/next-dev.js": { hash: "a4eeea8eb2a6a400376e564f3e0b26b4b441b85bfbc2603b8c6f903c82f4eba7", edits: 1 },
  "dist/server/lib/start-server.js": { hash: "481c750a6adee52e3210be8436ad8570af6982e0a85432834fc225067955d4fa", edits: 6 },
  "dist/lib/memory/trace.js": { hash: "7f436933a27448f61cac22fc2881c878b972709243b61057e498bcd4ed89a0f3", edits: 9 },
  "dist/server/dev/next-dev-server.js": { hash: "8f4beed75278045195a033208192bffeff677ea7061fc27cf0bec114977fa8c5", edits: 4 },
};

/** Mutate the already-parsed tree so the existing generator retains original
 * source locations/content. Never rewrite installed bytes or application APIs. */
export function applyNextMemoryException(tree: File, source: string, filename: string, files?: LocalModuleFiles): boolean {
  const marker = "/node_modules/next/";
  const index = filename.lastIndexOf(marker);
  if (index === -1) return false;
  const relative = filename.slice(index + marker.length);
  if (!Object.hasOwn(sources, relative)) return false;
  const expected = sources[relative];
  if (expected === undefined) return false;
  const fail = (reason: string): never => { throw new VMError("FEATURE_NOT_AVAILABLE", `Next memory exception rejected: ${reason}`, {
    module: filename, exception: NEXT_MEMORY_EXCEPTION,
  }); };
  if (files?.dependencies === undefined) return fail("installed dependency identity is required");
  const packageSource = files.read(`${filename.slice(0, index + marker.length)}package.json`);
  if (packageSource.format !== "json") return fail("invalid package metadata format");
  let metadata: unknown;
  try { metadata = JSON.parse(packageSource.source); }
  catch { return fail("invalid package metadata"); }
  if (typeof metadata !== "object" || metadata === null || !("name" in metadata) || metadata.name !== "next" ||
      !("version" in metadata) || metadata.version !== "16.2.12") return fail("package version does not match");
  if (bytesToHex(sha256(new TextEncoder().encode(source))) !== expected.hash) return fail("source hash does not match");
  let edits = 0;
  const text = (node: { start?: number | null; end?: number | null }): string => {
    if (node.start == null || node.end == null) return fail("missing source identity");
    return source.slice(node.start, node.end);
  };
  traverseModule(tree, {
    IfStatement(path) {
      const test = text(path.node.test);
      if ((relative === "dist/cli/next-dev.js" && test === "!maxOldSpaceSize && !process.env.NEXT_DISABLE_MEM_OVERRIDE") ||
          (relative === "dist/server/lib/start-server.js" && test === "_v8.default.getHeapStatistics().used_heap_size > 0.8 * _v8.default.getHeapStatistics().heap_size_limit") ||
          (relative === "dist/lib/memory/trace.js" && test === "process.env.EXPERIMENTAL_DEBUG_MEMORY_USAGE")) {
        path.remove(); edits++;
      }
    },
    VariableDeclaration(path) {
      if (path.node.declarations.length !== 1) return;
      const declaration = path.node.declarations[0];
      if (declaration?.id.type !== "Identifier") return;
      const names = relative === "dist/lib/memory/trace.js"
        ? ["memoryUsage", "v8HeapStatistics", "heapUsed", "heapMax"] : ["memoryUsage"];
      if (names.includes(declaration.id.name)) { path.remove(); edits++; }
    },
    ObjectProperty(path) {
      if (path.node.key.type !== "StringLiteral") return;
      const names = relative === "dist/server/lib/start-server.js" ? ["memory.heapSizeLimit"]
        : ["memory.rss", "memory.heapUsed", "memory.heapTotal", "memory.heapMax"];
      if (names.includes(path.node.key.value)) { path.remove(); edits++; }
    },
    ExpressionStatement(path) {
      if (relative === "dist/server/lib/start-server.js" &&
          /^startServerSpan\.setAttribute\('memory\.(rss|heapTotal|heapUsed)',/u.test(text(path.node))) {
        path.remove(); edits++;
      }
    },
  });
  if (edits !== expected.edits) return fail("AST edit count does not match");
  return true;
}
