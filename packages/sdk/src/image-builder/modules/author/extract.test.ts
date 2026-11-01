import { describe, expect, it } from "vitest";
import { extractManifest, MAX_MODULE_SOURCE_BYTES } from "./extract.js";
import { BuildFailure } from "./findings.js";

const BASE = `{ id: "demo", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } }`;
const HEADER = `import { defineModule } from "@oxidevm/sdk/wasm";\n`;

function module(manifest: string = BASE, before = ""): string {
  return `${HEADER}${before}export default defineModule({\n  manifest: ${manifest},\n  adapter: host => ({ main: () => (host.fs ? 0 : 1) }),\n});\n`;
}

function failureOf(run: () => unknown): BuildFailure {
  try { run(); } catch (error) { if (error instanceof BuildFailure) return error; throw error; }
  throw new Error("expected the extraction to fail");
}
function one(source: string): { readonly code: string; readonly message: string; readonly line?: number; readonly column?: number; readonly file?: string } {
  const [first, ...rest] = failureOf(() => extractManifest(source, "module.ts")).findings;
  expect(rest).toEqual([]);
  if (first === undefined) throw new Error("no finding");
  return first;
}

describe("extractManifest", () => {
  it("reads a literal manifest into a validated declaration", () => {
    const declaration = extractManifest(module(), "module.ts");
    expect(declaration).toMatchObject({ id: "demo", version: "1.0.0", abi: "raw", process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } });
  });

  it.each([
    ["as const", BASE.replace("process: { kind: \"command\" }", "process: { kind: \"command\" } as const")],
    ["satisfies", `({ id: "demo", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } }) satisfies object`],
    ["quoted keys", BASE.replace("id:", "\"id\":")],
    ["substitution-free template strings", BASE.replace("\"demo\"", "`demo`")],
    ["trailing commas", BASE.replace("spdx: \"MIT\" }", "spdx: \"MIT\", }")],
  ])("accepts %s", (_label, manifest) => {
    expect(extractManifest(module(manifest), "module.ts").id).toBe("demo");
  });

  it("finds the manifest under a quoted key", () => {
    const source = `${HEADER}export default defineModule({ "manifest": ${BASE}, adapter: () => ({ main: () => 0 }) });\n`;
    expect(extractManifest(source, "module.ts").id).toBe("demo");
  });

  it("reads negative numbers and nested option declarations", () => {
    const manifest = BASE.replace("license:", `options: { depth: { type: "integer", min: -5, max: 5, default: -1 } }, license:`);
    expect(extractManifest(module(manifest), "module.ts")).toMatchObject({ options: { depth: { type: "integer", min: -5, max: 5, default: -1 } } });
  });

  it("never runs the module: top-level code is not executed", () => {
    expect(extractManifest(module(BASE, `throw new Error("author code ran");\n`), "module.ts").id).toBe("demo");
  });

  it.each([
    ["a reference", BASE.replace("\"demo\"", "NAME"), "manifest.id", "a reference to NAME"],
    ["a call", BASE.replace("\"1.0.0\"", "version()"), "manifest.version", "a call"],
    ["a property access", BASE.replace("\"MIT\"", "licenses.mit"), "manifest.license.spdx", "a property access"],
    ["a function", BASE.replace("artifacts: []", "artifacts: () => []"), "manifest.artifacts", "a function"],
    ["a template with substitutions", BASE.replace("\"demo\"", "`de${mo}`"), "manifest.id", "template with substitutions"],
    ["a spread", BASE.replace("artifacts: []", "...other"), "manifest", "spreads"],
    ["a computed key", BASE.replace("id:", "[key]:"), "manifest", "computed keys"],
    ["a method", BASE.replace("id: \"demo\"", "id() { return \"demo\"; }"), "manifest", "methods"],
    ["a shorthand property", BASE.replace("id: \"demo\"", "id"), "manifest.id", "a reference to id"],
    ["a duplicate key", BASE.replace("id: \"demo\",", "id: \"demo\", id: \"other\","), "manifest.id", "declared twice"],
    ["an array hole", BASE.replace("artifacts: []", "artifacts: [,]"), "manifest.artifacts[0]", "hole"],
    ["a type assertion other than const", BASE.replace("artifacts: []", "artifacts: [] as unknown[]"), "manifest.artifacts", "a TSAsExpression"],
    ["a __proto__ key", BASE.replace("id:", "__proto__:"), "manifest", "property name"],
  ])("rejects %s with a located manifest-literal finding", (_label, manifest, path, fragment) => {
    const found = one(module(manifest));
    expect(found.code).toBe("manifest-literal");
    expect(found.message).toContain(path);
    expect(found.message).toContain(fragment);
    expect(found.file).toBe("module.ts");
    expect(found.line).toBe(3);
    expect(found.column).toBeGreaterThan(0);
  });

  it("points at the exact line and column of the offending value", () => {
    const source = `${HEADER}export default defineModule({\n  manifest: {\n    id: "demo",\n    version: VERSION,\n    abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: [] }, license: { spdx: "MIT" },\n  },\n  adapter: () => ({ main: () => 0 }),\n});\n`;
    const found = one(source);
    expect(found).toMatchObject({ code: "manifest-literal", file: "module.ts", line: 5, column: 14 });
  });

  it.each([
    ["no default export", `${HEADER}export const module = defineModule({ manifest: ${BASE}, adapter: () => ({ main: () => 0 }) });\n`, "no default export"],
    ["two default exports", `${module()}export default 1;\n`, "more than one default export"],
    ["a default export that is not a call", `${HEADER}const built = defineModule({ manifest: ${BASE}, adapter: () => ({ main: () => 0 }) });\nexport default built;\n`, "something else"],
    ["a renamed defineModule", `import { defineModule as define } from "@oxidevm/sdk/wasm";\nexport default define({ manifest: ${BASE}, adapter: () => ({ main: () => 0 }) });\n`, "something else"],
    ["two arguments", `${HEADER}export default defineModule({ manifest: ${BASE} }, 1);\n`, "something else"],
    ["a non-object argument", `${HEADER}export default defineModule(options);\n`, "one object literal"],
    ["no manifest property", `${HEADER}export default defineModule({ adapter: () => ({ main: () => 0 }) });\n`, "no `manifest` property"],
  ])("rejects %s", (_label, source, fragment) => {
    const found = one(source);
    expect(found.code).toBe("manifest-literal");
    expect(found.message).toContain(fragment);
    expect(found.message).toContain("defineModule");
  });

  it("rejects a manifest declared outside the call, because only a literal can be read without running code", () => {
    const found = one(`${HEADER}const manifest = ${BASE};\nexport default defineModule({ manifest, adapter: () => ({ main: () => 0 }) });\n`);
    expect(found).toMatchObject({ code: "manifest-literal", file: "module.ts", line: 3 });
    expect(found.message).toContain("a reference to manifest");
  });

  it("reports a syntax error with its position as a module-source finding", () => {
    const found = one(`${HEADER}export default defineModule({ manifest: ;\n`);
    expect(found.code).toBe("module-source");
    expect(found.message).toContain("does not parse");
    expect(found).toMatchObject({ file: "module.ts", line: 2 });
  });

  it("reports an invalid declaration with the decoder's reason, located at the manifest", () => {
    const found = one(module(BASE.replace("abi: \"raw\"", "abi: \"cobol\"")));
    expect(found.code).toBe("manifest-invalid");
    expect(found.message).toContain("abi");
    expect(found).toMatchObject({ file: "module.ts", line: 3 });
  });

  it("rejects an unknown manifest key as invalid", () => {
    expect(one(module(BASE.replace("license:", "surprise: true, license:"))).code).toBe("manifest-invalid");
  });

  describe("commands", () => {
    const withCommands = (list: string): string => BASE.replace("requires:", `commands: ${list}, requires:`);

    it("reads a literal list of names into a sorted set right after process", () => {
      const declaration = extractManifest(module(withCommands(`["python3", "python"]`)), "module.ts");
      expect(declaration).toMatchObject({ commands: ["python", "python3"] });
      expect(Object.keys(declaration)).toEqual(["id", "version", "abi", "artifacts", "process", "commands", "requires", "license"]);
      expect(extractManifest(module(withCommands(`["demo"] as const`)), "module.ts")).toMatchObject({ commands: ["demo"] });
    });

    it.each([
      ["a reference", "NAMES", "manifest.commands", "a reference to NAMES"],
      ["a spread", "[...NAMES]", "manifest.commands[0]", "a spread"],
      ["a call", "names()", "manifest.commands", "a call"],
      ["a mapped list", `["demo"].map(name => name)`, "manifest.commands", "a call"],
      ["a computed name", "[`demo${SUFFIX}`]", "manifest.commands[0]", "template with substitutions"],
      ["a referenced name", `["demo", NAME]`, "manifest.commands[1]", "a reference to NAME"],
    ])("refuses %s, because the build reads commands without running code", (_label, list, path, fragment) => {
      const found = one(module(withCommands(list)));
      expect(found.code).toBe("manifest-literal");
      expect(found.message).toContain(path);
      expect(found.message).toContain(fragment);
    });

    it("reports commands on a service or an invalid list with the decoder's reason", () => {
      const service = `{ id: "demo", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "service" }, expose: { sql: { kind: "unix", path: "/tmp/demo.sock", protocol: "demo/1" } }, commands: ["demo"], requires: { host: [] }, license: { spdx: "MIT" } }`;
      const cases: readonly (readonly [string, RegExp])[] = [
        [module(service), /^commands: a service cannot declare commands/u],
        [module(withCommands(`["Demo"]`)), /^commands: "Demo" is not a command name/u],
        [module(withCommands("[]")), /^commands: must name at least one command/u],
      ];
      for (const [source, message] of cases) {
        const found = one(source);
        expect(found.code).toBe("manifest-invalid");
        expect(found.message).toMatch(message);
      }
    });
  });

  it("refuses a source larger than the limit before parsing it", () => {
    const found = one(`// ${"x".repeat(MAX_MODULE_SOURCE_BYTES)}\n`);
    expect(found.code).toBe("module-source");
    expect(found.message).toContain(String(MAX_MODULE_SOURCE_BYTES));
  });
});
