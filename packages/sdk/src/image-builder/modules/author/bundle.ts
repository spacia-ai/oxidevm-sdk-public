import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { relative, resolve } from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { build } from "esbuild";
import type { Message, Metafile, Plugin } from "esbuild";
import { record } from "../../../runtime/decode.js";
import { abortIfRequested } from "../../tools.js";
import { BuildFailure, finding, MAX_BUNDLED_PACKAGES, MAX_PACKAGE_LICENSE, MAX_PACKAGE_NAME, MAX_PACKAGE_VERSION } from "./findings.js";
import type { Finding } from "./findings.js";
import { bundlePosition } from "./lint.js";
import type { Locate } from "./lint.js";

/** A third-party package whose code ended up in the adapter, as its own `package.json` describes it. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

/** An import in dependency code that nothing in a worker can satisfy, replaced with an empty module. */
export interface StubbedImport {
  readonly specifier: string;
  /** The importing file, relative to the project. */
  readonly importer: string;
}

export interface Bundle {
  /** The self-contained ES module a release ships as `adapter.mjs`. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly text: string;
  /** Maps a position in `text` to the author's file. */
  readonly locate: Locate;
  readonly packages: readonly BundledPackage[];
  readonly stubbed: readonly StubbedImport[];
}

const SDK_ENTRY = "@oxidevm/sdk/wasm";
const STUB_NAMESPACE = "oxidevm-sdk";

/**
 * An adapter never runs SDK code: everything it needs arrives through `host`. The one value it imports is
 * `defineModule`, which is the identity at run time, so it is replaced here and everything else from the SDK is refused.
 */
// esbuild passes plugin filters to Go's regexp engine, which has no `u` flag, so these two are written without it.
const sdkStub: Plugin = {
  name: "oxidevm-sdk-stub",
  setup(builder) {
    builder.onResolve({ filter: /^@oxidevm\/sdk(?:\/.*)?$/ }, args => args.path === SDK_ENTRY
      ? { path: SDK_ENTRY, namespace: STUB_NAMESPACE }
      : { errors: [{ text: `"${args.path}" cannot be bundled into an adapter: it receives everything through \`host\`. Import types with \`import type\`, and the one value \`defineModule\` from "${SDK_ENTRY}".` }] });
    builder.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({ contents: "export const defineModule = definition => definition;\n", loader: "js" }));
  },
};

const STUB_NAMESPACE_EMPTY = "oxidevm-empty";
/** Marks the resolution this plugin starts itself, so that it does not intercept its own question. */
const RESOLVING = "oxidevm-resolving";
const BUILTIN_ROOTS: ReadonlySet<string> = new Set(builtinModules.map(name => name.split("/")[0] ?? name));

function isDependencyCode(importer: string): boolean {
  return /[\\/]node_modules[\\/]/u.test(importer);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTIN_ROOTS.has(specifier.split("/")[0] ?? specifier);
}

/**
 * Third-party code written for several environments mentions Node built-ins and optional packages on branches a worker
 * never takes (Pyodide's loader imports `node:fs` and `ws` that way). Bundling such code would fail on imports that are
 * dead in a worker, so, for code under node_modules only, an import that cannot be resolved is replaced with an empty
 * module when it names a Node built-in or is a dynamic import or `require`. The author's own files get no such allowance,
 * a missing package in a static import is still an error, and every replacement is reported.
 */
function dependencyStubs(projectDir: string, stubbed: StubbedImport[]): Plugin {
  return {
    name: "oxidevm-dependency-stubs",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === RESOLVING || args.kind === "entry-point" || !isDependencyCode(args.importer)) return undefined;
        const resolved = await builder.resolve(args.path, { importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, kind: args.kind, pluginData: RESOLVING });
        // Found, or handled by esbuild itself (a package.json "browser" field that disables the module, a try block): leave it to esbuild.
        if (resolved.errors.length === 0) return undefined;
        if (!isNodeBuiltin(args.path) && args.kind !== "dynamic-import" && args.kind !== "require-call") return undefined;
        stubbed.push({ specifier: args.path, importer: relative(projectDir, args.importer) });
        return { path: args.path, namespace: STUB_NAMESPACE_EMPTY };
      });
      builder.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE_EMPTY }, () => ({ contents: "export default {};\n", loader: "js" }));
    },
  };
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "text") === "string";
}

/** esbuild reports its problems on the thrown error; each becomes a located finding. */
function findingsOf(error: unknown): readonly Finding[] | undefined {
  const messages: unknown = error instanceof Error ? Reflect.get(error, "errors") : undefined;
  if (!Array.isArray(messages)) return undefined;
  return Array.from<unknown>(messages).filter(isMessage).map(message => finding("error", "adapter-bundle", message.text, message.location === null ? {} : { file: message.location.file, line: message.location.line, column: message.location.column + 1 }));
}

function locator(map: string): Locate {
  const trace = new TraceMap(map);
  return (line, column) => {
    const original = originalPositionFor(trace, { line, column });
    return original.source === null ? bundlePosition(line, column) : { file: original.source, line: original.line, column: original.column + 1 };
  };
}

/** `name` or `@scope/name` of the package a file under node_modules belongs to. */
export function packageNameOf(path: string): string | undefined {
  const directory = packageDirectory(path);
  return directory?.slice(directory.lastIndexOf("node_modules/") + "node_modules/".length);
}

/** The directory of the package a bundled input belongs to, e.g. `node_modules/@scope/name` for a file inside it. */
function packageDirectory(input: string): string | undefined {
  const parts = input.split("/");
  const index = parts.lastIndexOf("node_modules");
  const first = parts[index + 1];
  if (index < 0 || first === undefined) return undefined;
  return parts.slice(0, index + 1 + (first.startsWith("@") ? 2 : 1)).join("/");
}

/** A package.json value as the build report can carry it: a non-empty string within its bound, otherwise nothing. */
function within(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0") ? value : undefined;
}

async function describePackage(projectDir: string, directory: string): Promise<BundledPackage> {
  const fallback = within(directory.slice(directory.lastIndexOf("node_modules/") + "node_modules/".length), MAX_PACKAGE_NAME) ?? "unknown-package";
  try {
    const manifest = record(JSON.parse(await readFile(resolve(projectDir, directory, "package.json"), "utf8")) as unknown, "package.json");
    const declared = manifest["license"];
    const license = within(typeof declared === "object" && declared !== null ? Reflect.get(declared, "type") : declared, MAX_PACKAGE_LICENSE) ?? "UNKNOWN";
    return { name: within(manifest["name"], MAX_PACKAGE_NAME) ?? fallback, version: within(manifest["version"], MAX_PACKAGE_VERSION) ?? "unknown", license };
  } catch {
    return { name: fallback, version: "unknown", license: "UNKNOWN" };
  }
}

/** The packages that contributed code to the output, sorted by name and version so the list is stable. */
async function bundledPackages(projectDir: string, metafile: Metafile): Promise<readonly BundledPackage[]> {
  const directories = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, usage] of Object.entries(output.inputs)) {
      // A file esbuild replaced with an empty module (`(disabled):path`, from a package.json browser field) put none of its package's code in the output.
      const directory = usage.bytesInOutput > 0 && !input.startsWith("(disabled):") ? packageDirectory(input) : undefined;
      if (directory !== undefined) directories.add(directory);
    }
  }
  if (directories.size > MAX_BUNDLED_PACKAGES) {
    throw new BuildFailure([finding("error", "adapter-bundle", `the adapter bundles ${String(directories.size)} third-party packages; a module adapter can list at most ${String(MAX_BUNDLED_PACKAGES)}, so depend on fewer or bundle less`)]);
  }
  const described = await Promise.all([...directories].map(directory => describePackage(projectDir, directory)));
  return described.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
}

/**
 * Bundles the author's module into the one self-contained ES module a release ships. Its default export is the
 * adapter factory. The result is deterministic for the same inputs and esbuild version: no timestamps, no absolute
 * paths (comments name files relative to the project), legal comments kept at the end of the file.
 */
export async function bundleAdapter(projectDir: string, modulePath: string, signal?: AbortSignal): Promise<Bundle> {
  abortIfRequested(signal);
  const stubbed: StubbedImport[] = [];
  let result;
  try {
    result = await build({
      absWorkingDir: projectDir,
      stdin: { contents: `import adapterModule from ${JSON.stringify(`./${modulePath}`)};\nexport default adapterModule.adapter;\n`, resolveDir: projectDir, sourcefile: "oxidevm-adapter-entry.js", loader: "js" },
      outfile: resolve(projectDir, "adapter.mjs"), write: false, bundle: true, format: "esm", platform: "browser", target: "es2024", charset: "utf8",
      minify: false, treeShaking: true, legalComments: "eof", sourcemap: "external", sourcesContent: false, metafile: true, logLevel: "silent",
      define: { "process.env.NODE_ENV": "\"production\"" }, plugins: [sdkStub, dependencyStubs(projectDir, stubbed)],
    });
  } catch (error) {
    const found = findingsOf(error);
    if (found !== undefined) throw new BuildFailure(found);
    throw error;
  }
  abortIfRequested(signal);
  const code = result.outputFiles.find(file => file.path.endsWith("adapter.mjs"));
  const map = result.outputFiles.find(file => file.path.endsWith("adapter.mjs.map"));
  if (code === undefined || map === undefined) throw new BuildFailure([finding("error", "adapter-bundle", "the bundler produced no output")]);
  // esbuild asks once per specifier and importing file, so there are no repeats to remove.
  const ordered = stubbed.sort((left, right) => left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : left.importer < right.importer ? -1 : left.importer > right.importer ? 1 : 0);
  return { bytes: new Uint8Array(code.contents), text: code.text, locate: locator(map.text), packages: await bundledPackages(projectDir, result.metafile), stubbed: ordered };
}
