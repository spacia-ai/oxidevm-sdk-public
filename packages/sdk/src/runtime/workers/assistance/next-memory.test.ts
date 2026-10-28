import { expect, it } from "vitest";
import { lowerScriptImports } from "./script-imports.ts";
import { nodeV8Memory, processMemoryUsage } from "./node-memory.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import { VMError } from "../../errors.ts";

const path = "/workspace/node_modules/.pnpm/next@16.2.12/node_modules/next/dist/server/lib/start-server.js";
const files: LocalModuleFiles = {
  dependencies: { generation: "a".repeat(64), inputsSha256: "b".repeat(64) },
  resolve: specifier => specifier,
  read: () => ({ source: '{"name":"next","version":"16.2.12"}', format: "json" }),
};

it("fails closed on missing dependency identity, changed Next bytes or a different version", () => {
  expect(() => lowerScriptImports("process.memoryUsage();", path)).toThrow("dependency identity");
  expect(() => lowerScriptImports("process.memoryUsage();", path, files)).toThrow("source hash");
  expect(() => lowerScriptImports("process.memoryUsage();", path, {
    ...files, read: () => ({ source: '{"name":"next","version":"16.2.13"}', format: "json" }),
  })).toThrow("package version");
  const ordinary = lowerScriptImports("process.memoryUsage();", "/workspace/app.js", files);
  expect(ordinary.memoryException).toBe(false);
  expect(ordinary.code).toContain("process.memoryUsage()");
  expect(lowerScriptImports("process.memoryUsage();", "/workspace/node_modules/next/__proto__", files).memoryException).toBe(false);
});

it("authenticates the dev CLI before omitting its automatic child heap override", () => {
  const cli = path.replace("dist/server/lib/start-server.js", "dist/cli/next-dev.js");
  const source = "if (!maxOldSpaceSize && !process.env.NEXT_DISABLE_MEM_OVERRIDE) { nodeOptions['max-old-space-size'] = '2048'; }";
  expect(() => lowerScriptImports(source, cli)).toThrow("dependency identity");
  expect(() => lowerScriptImports(source, cli, files)).toThrow("source hash");
  expect(() => lowerScriptImports(source, cli, {
    ...files, read: () => ({ source: '{"name":"next","version":"16.2.13"}', format: "json" }),
  })).toThrow("package version");
  expect(lowerScriptImports(source, "/workspace/dev.js", files).code).toContain("max-old-space-size");
});

it("rejects actual memory calls with the API and originating source in the structured error", () => {
  for (const operation of [...Object.values(nodeV8Memory), processMemoryUsage, processMemoryUsage.rss]) {
    try { operation(); expect.fail("memory operation returned invented statistics"); }
    catch (error) {
      expect(error).toBeInstanceOf(VMError);
      if (!(error instanceof VMError)) throw error;
      expect(error.code).toBe("FEATURE_NOT_AVAILABLE");
      expect(error.detail?.["api"]).toMatch(/^(v8\.|process\.memoryUsage)/u);
      expect(error.detail?.["origin"]).toContain("next-memory.test.ts");
    }
  }
});
