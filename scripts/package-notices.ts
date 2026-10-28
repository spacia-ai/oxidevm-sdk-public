import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";
import { selectedLicense } from "./license-expression.ts";
import { verifyLicensePolicy } from "./license-policy.ts";
import { TYPESCRIPT } from "../packages/sdk/src/runtime/command-interceptor-identity.ts";

function array(value: unknown): readonly unknown[] { assert(Array.isArray(value), "License inventory requires an array"); return Array.from<unknown>(value); }
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function checkedCompilerComponents(value: unknown, allowed: ReadonlySet<string>): readonly Record<string, unknown>[] {
  return array(value).map(value => {
    const component = record(value, "bundled compiler component"), licenses = array(component["licenses"]), properties = array(component["properties"]).map(value => record(value, "compiler property"));
    const declarations = properties.filter(item => item["name"] === "oxidevm:declared-license"), declaration = declarations[0];
    assert(declarations.length === 1 && declaration !== undefined && licenses.length === 1, "Bundled compiler lacks its exact license election");
    const selected = string(record(licenses[0], "compiler license")["expression"], "selected compiler license");
    assert.equal(selectedLicense(string(declaration["value"], "declared compiler license"), allowed), selected, "Compiler license branch or AND obligations differ from the distribution policy");
    return component;
  });
}

export async function generatePackageNotices(root: string, name: "sdk" | "cli"): Promise<void> {
  const policySHA256 = await verifyLicensePolicy(root), directory = join(root, "packages", name);
  for (const file of ["LICENSE", "NOTICE"]) {
    const canonical = await readFile(join(root, file));
    assert(canonical.equals(await readFile(join(directory, file))), `Package lost its canonical ${file}`);
    assert(canonical.equals(await readFile(join(root, "examples/starter", file))), `Starter lost its canonical ${file}`);
  }
  const allowed = new Set(array(JSON.parse(await readFile(join(root, "config/allowed-licenses.json"), "utf8"))).map(value => string(value, "license identifier")));
  const inventory = record(JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 ** 2, timeout: 120_000 })), "production dependency inventory");
  const modules = await readFile(join(root, "node_modules/.modules.yaml"), "utf8");
  const configured = modules.trimStart().startsWith("{") ? record(JSON.parse(modules), "pnpm modules")["virtualStoreDir"] : /^virtualStoreDir: (.+)$/mu.exec(modules)?.[1];
  const virtualStore = resolve(root, "node_modules", typeof configured === "string" ? configured : ".pnpm");
  const notices: string[] = [], components: Record<string, unknown>[] = [], seen = new Set<string>();
  for (const [declared, values] of Object.entries(inventory)) for (const value of array(values)) {
    const pkg = record(value, "dependency"), packageName = string(pkg["name"], "dependency name");
    const paths = array(pkg["paths"]).map(value => string(value, "installed package path").replace(`${root}/node_modules/.pnpm/`, `${virtualStore}/`));
    if (/^(?:oxidevm-sdk-workspace|@oxidevm\/[^/]+|@oxidevm-example\/[^/]+)$/u.test(packageName) && paths.length > 0 && paths.every(path => (path === root || path.startsWith(`${root}/packages/`) || path.startsWith(`${root}/examples/`)) && !path.includes("/node_modules/"))) continue;
    const selected = selectedLicense(declared, allowed); assert(selected !== undefined, `Unapproved distributed license: ${packageName}: ${declared}`);
    for (const version of array(pkg["versions"]).map(value => string(value, "dependency version"))) {
      const key = `${packageName}@${version}`; if (seen.has(key)) continue; seen.add(key);
      let installed: string | undefined;
      for (const path of paths) { const manifest = record(JSON.parse(await readFile(join(path, "package.json"), "utf8")), "installed dependency"); if (manifest["version"] === version && manifest["name"] === packageName) { installed = path; break; } }
      assert(installed !== undefined, `Missing installed license source: ${key}`);
      const sections: string[] = [];
      for (const file of (await readdir(installed, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) if (file.isFile() && /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)(?:[._-]|$)/iu.test(file.name)) {
        const bytes = await readFile(join(installed, file.name)); assert(bytes.length > 10 && bytes.length < 2 * 1024 ** 2 && !bytes.includes(0), `Invalid license notice: ${key}`); sections.push(`${file.name}\n${bytes.toString()}`);
      }
      if (sections.length === 0 && packageName.startsWith("@esbuild/") && selected === "MIT") {
        const owner = record(JSON.parse(await readFile(join(root, "packages/sdk/node_modules/esbuild/package.json"), "utf8")), "esbuild package");
        assert.equal(owner["version"], version, "Native esbuild and its source license differ");
        sections.push(await readFile(join(root, "packages/sdk/node_modules/esbuild/LICENSE.md"), "utf8"));
      }
      assert(sections.some(section => section.length > 100), `Missing complete license text: ${key}`);
      notices.push(`${key}\nDeclared: ${declared}\nSelected: ${selected}\n${sections.join("\n")}\n`);
      components.push({ type: "library", name: packageName, version, "bom-ref": `npm:${key}`, licenses: [{ expression: selected }], properties: [{ name: "oxidevm:declared-license", value: declared }, { name: "oxidevm:use", value: "production install dependency closure; bundled code retains notices" }] });
    }
  }
  assert(components.length > 0, "An empty installed inventory cannot qualify a package");
  const swcRoot = join(root, "packages/sdk/legal/swc"), swc = record(JSON.parse(await readFile(join(swcRoot, "inputs.json"), "utf8")), "pinned compiler inventory");
  const compilerNotices = await readFile(join(swcRoot, "NOTICES.txt")), compilerSBOM = await readFile(join(swcRoot, "sbom.cdx.json"));
  assert.equal(hash(compilerNotices), swc["noticesSHA256"], "SWC notices changed without a new inventory"); assert.equal(hash(compilerSBOM), swc["sbomSHA256"]);
  assert.equal(hash(await readFile(join(root, "packages/sdk/node_modules/@swc/wasm-web/wasm_bg.wasm"))), swc["wasmSHA256"], "SWC compiler differs from its nested license inventory");
  notices.push(`Nested SWC compiler notices\n${compilerNotices.toString()}`);
  components.push(...checkedCompilerComponents(record(JSON.parse(compilerSBOM.toString()), "compiler SBOM")["components"], allowed));
  for (const file of ["node-util.ts", "node-warnings.ts", "node-util-style.ts", "node-async-hooks.ts"]) {
    const source = await readFile(join(root, "packages/sdk/src/runtime/workers/assistance", file), "utf8"), header = /^\/\*[\s\S]*?\*\//u.exec(source)?.[0];
    assert(header?.includes("Permission is hereby granted") === true, `Node-derived source lost its notice: ${file}`); notices.push(`${file}: Node.js-derived source, MIT\n${header}`);
  }
  for (const font of ["Archivo", "Roboto", "JetBrainsMono"]) notices.push(`${font}: OFL-1.1\n${await readFile(join(root, `examples/starter/public/fonts/${font}-OFL.txt`), "utf8")}`);
  for (const font of ["archivo", "roboto", "jetbrains-mono"]) components.push({ type: "file", name: `${font}.woff2`, "bom-ref": `font:${font}`, hashes: [{ alg: "SHA-256", content: hash(await readFile(join(root, `examples/starter/public/fonts/${font}.woff2`))) }], licenses: [{ expression: "OFL-1.1" }] });
  for (const file of ["assets/compilers/esbuild-LICENSE.txt", "assets/compilers/Go-LICENSE.txt", "assets/interceptors/TypeScript-LICENSE.txt"]) notices.push(`${file}\n${await readFile(join(root, "packages/sdk", file), "utf8")}`);
  components.push({ type: "library", name: "TypeScript Linux bridge compiler", version: TYPESCRIPT.version, "bom-ref": "oxidevm:typescript-interceptor", licenses: [{ expression: "Apache-2.0" }], properties: [{ name: "oxidevm:modified", value: "Pinned System initializer replaced with the Linux filesystem bridge" }] });
  const go = record(JSON.parse(await readFile(join(root, "packages/sdk/assets/compilers/esbuild.provenance.json"), "utf8")), "Go compiler provenance");
  components.push({ type: "library", name: "Go runtime", version: go["goVersion"], "bom-ref": "oxidevm:esbuild-go-runtime", licenses: [{ expression: "BSD-3-Clause" }], properties: [{ name: "oxidevm:toolchain-sha256", value: go["toolchainSHA256"] }, { name: "oxidevm:vendor-modules-sha256", value: go["goVendorModulesSHA256"] }] });
  for (const value of array(go["goVendoredVersions"])) { const dependency = record(value, "Go linked dependency"); assert.equal(dependency["license"], "BSD-3-Clause"); components.push({ type: "library", name: dependency["name"], version: dependency["version"], "bom-ref": `go:${String(dependency["name"])}`, licenses: [{ expression: "BSD-3-Clause" }] }); }
  const files: Record<string, unknown>[] = [];
  async function visit(path: string): Promise<void> {
    const absolute = join(directory, path), info = await lstat(absolute);
    if (info.isDirectory()) for (const entry of (await readdir(absolute)).sort()) await visit(`${path}/${entry}`);
    else { assert(info.isFile(), `Unexpected package symlink or artifact: ${path}`); if (path.endsWith(".wasm")) assert(!/oxidevm_(?:core|core_shared|userspace|netstack)/u.test(path), "Engine binary entered an Apache package"); files.push({ type: "file", name: path, "bom-ref": `file:${path}`, hashes: [{ alg: "SHA-256", content: hash(await readFile(absolute)) }] }); }
  }
  const manifest = record(JSON.parse(await readFile(join(directory, "package.json"), "utf8")), "package manifest");
  for (const path of array(manifest["files"]).map(value => string(value, "package file"))) if (!["legal", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json"].includes(path)) await visit(path);
  await writeFile(join(directory, "THIRD_PARTY_NOTICES.txt"), `Third-party license materials\n\nThese terms apply to the identified components. The package's Apache-2.0\nlicense does not replace them. Engine and guest binaries are distributed separately.\n\n${notices.join("\n\n")}`);
  await writeFile(join(directory, "sbom.cdx.json"), json({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "library", name: manifest["name"], version: manifest["version"], licenses: [{ expression: "Apache-2.0" }] }, properties: [{ name: "oxidevm:policy-sha256", value: policySHA256 }, { name: "oxidevm:inventory-boundary", value: "files listed by package metadata, excluding this SBOM, generated notices and rewritten package.json; release archive inventory covers the final container" }] }, components: [...components, ...files] }));
}

if (import.meta.main) { const name = process.argv[2]; assert((name === "sdk" || name === "cli") && process.argv.length === 3, "usage: node scripts/package-notices.ts sdk|cli"); await generatePackageNotices(resolve(import.meta.dirname, ".."), name); }
