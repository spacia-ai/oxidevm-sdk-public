import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { VMError } from "@oxidevm/sdk";
import { WasmBuildFailure, extractManifest, getSDKRelease, inspectWasm } from "@oxidevm/sdk/image-builder";
import { file, newDirectory } from "./template-files.js";
import { registryConfig } from "./templates.js";
import { ADD_WASM, ESLINT_CONFIG, GITIGNORE, TEMPLATE_PLAYWRIGHT, OPERANDS_SOURCE, OPERANDS_TEST, TEST_TSCONFIG, TSCONFIG, agentsFile, ciWorkflow, moduleTest, noticeFile, readmeFile, releaseWorkflow } from "./wasm-template-files.js";

export type ModuleKind = "command" | "service";

export interface ModuleInitResult {
  readonly directory: string;
  readonly id: string;
  readonly kind: ModuleKind;
  readonly abi: string;
  /** Every file that was created, relative to the directory and sorted. */
  readonly files: readonly string[];
}

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** The largest WebAssembly file `--from` copies; it matches what a release pin can describe. */
const MAX_FROM_BYTES = 512 * 1024 ** 2;

/** A module id from a directory name: lowercase letters, digits and hyphens, starting with a letter. */
export function moduleIdFor(directory: string): string {
  const slug = basename(directory).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
  if (slug === "") return "my-module";
  return /^[a-z]/u.test(slug) ? slug : `module-${slug}`.slice(0, 63);
}

interface Subject {
  /** The artifact's name in the release. */
  readonly artifact: string;
  readonly abi: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** True when the module only wraps a file the author supplied and has no behavior yet. */
  readonly skeleton: boolean;
}

async function subjectFor(from: string | undefined, directory: string): Promise<Subject> {
  if (from === undefined) return { artifact: "add.wasm", abi: "raw", bytes: ADD_WASM, skeleton: false };
  const name = basename(from);
  if (!ARTIFACT_NAME.test(name) || !name.endsWith(".wasm")) throw new VMError("INVALID_ARGUMENT", `--from must name a .wasm file whose name is letters, digits, dots, hyphens or underscores, not ${JSON.stringify(name)}`);
  const bytes = new Uint8Array(await readFile(from).catch(() => { throw new VMError("INVALID_ARGUMENT", `--from ${JSON.stringify(from)} cannot be read`); }));
  if (bytes.byteLength > MAX_FROM_BYTES) throw new VMError("INVALID_ARGUMENT", "--from is larger than a release can pin");
  const report = await inspectWasm(bytes).catch((error: unknown) => { throw error instanceof VMError ? error : new VMError("INVALID_ARGUMENT", `--from ${JSON.stringify(from)} is not a WebAssembly binary`); });
  void directory;
  return { artifact: name, abi: report.abi, bytes, skeleton: true };
}

const MANIFEST_HEAD = (id: string, subject: Subject, kind: ModuleKind, host: string): string => `    id: ${JSON.stringify(id)},
    version: "0.1.0",
    abi: ${JSON.stringify(subject.abi)},
    artifacts: [{ name: ${JSON.stringify(subject.artifact)}, from: ${JSON.stringify(`upstream/${subject.artifact}`)} }],
    process: { kind: ${JSON.stringify(kind)} },
${kind === "service" ? `    expose: { main: { kind: "unix", path: ${JSON.stringify(`/workspace/_oxidevm/${id}.sock`)}, protocol: ${JSON.stringify(`${id}/1`)} } },\n` : ""}    requires: { host: [${host}] },
    license: { spdx: "Apache-2.0" },`;

function commandSource(id: string, subject: Subject): string {
  if (subject.skeleton) {
    return `import { defineModule } from "@oxidevm/sdk/wasm";

export default defineModule({
  manifest: {
${MANIFEST_HEAD(id, subject, "command", "")}
  },
  adapter: async host => {
    // Compile the artifact once, at start. Instantiate it here with the imports its ABI needs;
    // \`oxidevm wasm inspect upstream/${subject.artifact}\` lists them. Declare what the adapter uses in requires.host.
    await host.artifacts.compile(${JSON.stringify(subject.artifact)});
    return { main: () => host.fail(2, ${JSON.stringify(`${id} has no behavior yet: edit module.ts`)}) };
  },
});
`;
  }
  return `import { defineModule } from "@oxidevm/sdk/wasm";
import { parseOperands } from "./src/operands.ts";

export default defineModule({
  manifest: {
${MANIFEST_HEAD(id, subject, "command", "\"files.sync\"")}
  },
  adapter: async host => {
    const instance = await WebAssembly.instantiate(await host.artifacts.compile("add.wasm"));
    const add = instance.exports["add"];
    if (typeof add !== "function") throw new Error("add.wasm does not export add");
    return {
      main(io) {
        const operands = parseOperands(io.args);
        if (operands === undefined) return host.fail(2, ${JSON.stringify(`usage: ${id} <a> <b>  (two 32-bit integers)`)});
        const sum: unknown = Reflect.apply(add, undefined, operands);
        host.fs.write(io.stdout, new TextEncoder().encode(\`\${String(sum)}\\n\`));
        return 0;
      },
    };
  },
});
`;
}

function serviceSource(id: string, subject: Subject): string {
  if (subject.skeleton) {
    return `import { defineModule } from "@oxidevm/sdk/wasm";

export default defineModule({
  manifest: {
${MANIFEST_HEAD(id, subject, "service", "")}
  },
  adapter: async host => {
    // Compile the artifact once, at start, and keep what you build from it in this closure.
    await host.artifacts.compile(${JSON.stringify(subject.artifact)});
    return {
      protocols: {
        main: async connection => { await connection.write(new TextEncoder().encode("not implemented\\n")); },
      },
    };
  },
});
`;
  }
  return `import { defineModule } from "@oxidevm/sdk/wasm";
import { parseOperands } from "./src/operands.ts";

// One request per line, "<a> <b>", answered with "<sum>" or "error". A line longer than this closes the connection.
const MAX_LINE = 1024;

export default defineModule({
  manifest: {
${MANIFEST_HEAD(id, subject, "service", "").replace("expose: { main:", "expose: { add:")}
  },
  adapter: async host => {
    const instance = await WebAssembly.instantiate(await host.artifacts.compile("add.wasm"));
    const add = instance.exports["add"];
    if (typeof add !== "function") throw new Error("add.wasm does not export add");
    const encoder = new TextEncoder();
    return {
      protocols: {
        add: async connection => {
          const decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const chunk = await connection.read(4096);
            if (chunk.length === 0) return;
            pending += decoder.decode(chunk, { stream: true });
            for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
              const operands = parseOperands(pending.slice(0, end).split(" "));
              pending = pending.slice(end + 1);
              await connection.write(encoder.encode(operands === undefined ? "error\\n" : \`\${String(Reflect.apply(add, undefined, operands))}\\n\`));
            }
            if (pending.length > MAX_LINE) return;
          }
        },
      },
    };
  },
});
`;
}

function packageJson(id: string, kind: "command" | "service"): string {
  const version = getSDKRelease().sdkVersion;
  // The command template adds two numbers; without them its main stops at the usage error before the interesting path.
  const conformance = kind === "command" ? "oxidevm wasm build && oxidevm wasm test --arg 2 --arg 3" : "oxidevm wasm build && oxidevm wasm test";
  return `${JSON.stringify({
    name: id, private: true, license: "Apache-2.0", type: "module",
    scripts: { build: "oxidevm wasm build", check: "tsc --noEmit && tsc --noEmit -p test && eslint . --max-warnings 0 && oxidevm wasm build --check", release: "oxidevm wasm release", test: "vitest run", "test:conformance": conformance },
    devDependencies: { "@eslint/js": "10.0.1", "@oxidevm/cli": version, "@oxidevm/sdk": version, "@types/node": "24.13.3", eslint: "10.7.0", playwright: TEMPLATE_PLAYWRIGHT, typescript: "6.0.3", "typescript-eslint": "8.65.0", vitest: "3.2.4" },
  }, null, 2)}\n`;
}

/**
 * Creates a module project that builds and passes its own checks as generated. The module definition is read back
 * through the same extractor the build uses before anything is written, so an id or file name that would make an
 * invalid manifest fails here, not later.
 */
export async function initializeModule(directory: string, options: { readonly kind: ModuleKind; readonly id?: string; readonly from?: string }): Promise<ModuleInitResult> {
  const id = options.id ?? moduleIdFor(directory);
  const subject = await subjectFor(options.from, directory);
  const source = options.kind === "command" ? commandSource(id, subject) : serviceSource(id, subject);
  try { extractManifest(source, "module.ts"); } catch (error) {
    if (error instanceof WasmBuildFailure) throw new VMError("INVALID_ARGUMENT", `the module cannot be created: ${error.findings[0]?.message ?? "invalid manifest"}`);
    throw error;
  }
  const npmrc = await registryConfig();
  await newDirectory(directory);
  for (const sub of ["src", "test", "upstream", ".github/workflows"]) await mkdir(join(directory, sub), { recursive: true });
  const files = new Map<string, string | Uint8Array>([
    ["module.ts", source],
    [`upstream/${subject.artifact}`, subject.bytes],
    ["package.json", packageJson(id, options.kind)], ["tsconfig.json", TSCONFIG], ["test/tsconfig.json", TEST_TSCONFIG], ["test/module.test.ts", moduleTest(id, options.kind)], ["eslint.config.js", ESLINT_CONFIG], [".gitignore", GITIGNORE],
    ["README.md", readmeFile(id, options.kind)], ["AGENTS.md", agentsFile(id)],
    ["LICENSE", await readFile(new URL("../LICENSE", import.meta.url), "utf8")], ["NOTICE", noticeFile(id)],
    [".github/workflows/ci.yml", ciWorkflow(npmrc !== undefined)], [".github/workflows/release.yml", releaseWorkflow(npmrc !== undefined)],
  ]);
  if (!subject.skeleton) { files.set("src/operands.ts", OPERANDS_SOURCE); files.set("test/operands.test.ts", OPERANDS_TEST); }
  if (npmrc !== undefined) files.set(".npmrc", npmrc);
  for (const [path, content] of files) await file(directory, path, content);
  return { directory, id, kind: options.kind, abi: subject.abi, files: [...files.keys()].sort() };
}
