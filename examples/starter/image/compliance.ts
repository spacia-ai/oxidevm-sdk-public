import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import imageRecipe from "./oxidevm.image.ts";
import { decodeApkInventory, imageFileOwner } from "./inventory.ts";
import { decodeSourceLock, digest, fields, licenseNotices, run, sourceMaterials, text } from "./material-inputs.ts";
import { selectedLicense } from "../../../scripts/license-expression.ts";

interface Component { readonly name: string; readonly version: string; readonly license: string }
interface File { readonly path: string; readonly bytes: number; readonly sha256: string; readonly sha1: string; readonly owner: string }
const recipe = import.meta.dirname, repository = resolve(recipe, "../../.."), epoch = 1792886400;
const imageVersion = imageRecipe.version;
const componentId = (name: string) => `SPDXRef-Package-${name}`;
const fileId = (path: string) => `SPDXRef-File-${digest(path)}`;
const doc = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const supplementValue: unknown = JSON.parse(await readFile(join(recipe, "supplements.json"), "utf8"));
assert(Array.isArray(supplementValue) && supplementValue.length <= 16);
const supplements = Array.from<unknown>(supplementValue).map(value => {
  assert(typeof value === "object" && value !== null);
  const item = fields(value, "subdir" in value ? ["name", "version", "license", "archive", "subdir", "files"] : ["name", "version", "license", "archive", "files"]);
  assert(Array.isArray(item["files"]));
  const files = Array.from<unknown>(item["files"]).map(text), archive = text(item["archive"]), subdir = item["subdir"] === undefined ? "" : text(item["subdir"]);
  assert(/^[a-z0-9.-]+\.tar\.(?:gz|xz)$/u.test(archive) && /^[a-z0-9-]*$/u.test(subdir) && files.every(file => /^bin\/[a-z0-9-]+$/u.test(file)));
  return { name: text(item["name"]), version: text(item["version"]), license: text(item["license"]), archive, subdir, files };
});

async function checksums(directory: string, prefix = ""): Promise<readonly string[]> {
  const sums: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === "SHA256SUMS") continue;
    const path = join(directory, entry.name), name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) sums.push(...await checksums(path, `${name}/`));
    else { assert(entry.isFile() || entry.isSymbolicLink()); sums.push(`${digest(await readFile(path))}  ${name}\n`); }
  }
  return sums;
}

async function inventory(root: string, apk: ReturnType<typeof decodeApkInventory>): Promise<readonly File[]> {
  const files: File[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = `${prefix}${entry.name}`, absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, `${path}/`);
      else {
        assert(entry.isFile() || entry.isSymbolicLink(), `Unsupported guest file: ${path}`);
        const bytes = entry.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
        const owner = ["etc/passwd", "etc/group", "etc/hosts", "etc/resolv.conf"].includes(path) ? "oxidevm-starter-files"
          : path === "bin/toybox" || path === "usr/bin/env" || entry.isSymbolicLink() && bytes.toString() === "toybox" ? "toybox"
          : path === "bin/sh" || path === "bin/dash" ? "dash"
          : supplements.find(component => component.files.includes(path))?.name
            ?? (path === "lib/libc.musl-x86_64.so.1" ? "musl" : imageFileOwner(apk, path).origin);
        files.push({ path, bytes: bytes.length, sha256: digest(bytes), sha1: createHash("sha1").update(bytes).digest("hex"), owner });
      }
    }
  }
  await visit(root, ""); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** The final scratch image has no package database; capture its immutable input stage separately. */
async function capture(directory: string): Promise<void> {
  const tag = `oxidevm-nginx-materials-${randomUUID()}`, container = `${tag}-capture`;
  try {
    await run("docker", ["build", "--network=none", "--target", "inputs", "--tag", tag, recipe], { timeout: 300_000, maxBuffer: 8 * 1024 ** 2 });
    await run("docker", ["create", "--name", container, tag, "/bin/true"], { timeout: 30_000 });
    await run("docker", ["cp", `${container}:/lib/apk/db/installed`, join(directory, "apk-installed.txt")], { timeout: 30_000 });
    await run("docker", ["cp", `${container}:/rootfs`, join(directory, "rootfs")], { timeout: 30_000 });
    await run("docker", ["cp", `${container}:/utilities`, join(directory, "utilities")], { timeout: 30_000 });
  } finally {
    await run("docker", ["rm", "--force", container], { timeout: 30_000 }).catch(() => undefined);
    await run("docker", ["image", "rm", tag], { timeout: 30_000 }).catch(() => undefined);
  }
}

export async function prepareCompliance(): Promise<string> {
  const cache = join(recipe, ".cache"); await mkdir(cache, { recursive: true });
  const stage = await mkdtemp(join(cache, "materials-"));
  await capture(stage);
  const pinsValue: unknown = JSON.parse(await readFile(join(recipe, "components.json"), "utf8")); assert(Array.isArray(pinsValue));
  const components: readonly Component[] = Array.from<unknown>(pinsValue).map(value => { const pin = fields(value, ["name", "version", "license"]); return { name: text(pin["name"]), version: text(pin["version"]), license: text(pin["license"]) }; });
  const apkBytes = await readFile(join(stage, "apk-installed.txt")), apk = decodeApkInventory(apkBytes.toString());
  const lockValue: unknown = JSON.parse(await readFile(join(recipe, "source-lock.json"), "utf8")), lock = decodeSourceLock(lockValue);
  const canonicalPolicy = await readFile(join(repository, "config/allowed-guest-artifact-licenses.json"));
  const policyValue = fields(JSON.parse(canonicalPolicy.toString()), ["schemaVersion", "purpose", "review", "obligations", "licenses", "exceptions", "labelCorrections", "selections", "notApproved", "reviewedImages"]);
  assert(Array.isArray(policyValue["licenses"]));
  const licenses = new Set(Array.from<unknown>(policyValue["licenses"]).map(value => { assert(typeof value === "object" && value !== null && "id" in value); return text(value.id); }));
  assert(Array.isArray(policyValue["exceptions"]));
  for (const value of Array.from<unknown>(policyValue["exceptions"])) {
    assert(typeof value === "object" && value !== null);
    if ("expression" in value) licenses.add(text(value.expression));
  }
  const files = await inventory(join(stage, "rootfs"), apk);
  for (const component of components) {
    assert(selectedLicense(component.license, licenses) !== undefined, `Guest license needs review: ${component.license}`);
    if (["oxidevm-starter-files", "toybox", ...supplements.map(item => item.name)].includes(component.name)) continue;
    const packages = apk.filter(pkg => pkg.origin === component.name && files.some(file => pkg.files.includes(file.path)));
    assert(packages.length > 0 && packages.every(pkg => pkg.version === component.version && pkg.license === component.license), `APK component differs from recipe pin: ${component.name}`);
  }
  assert(files.every(file => components.some(component => component.name === file.owner)), "Guest file has no component pin");
  const materials = await sourceMaterials(join(stage, "materials"), join(cache, "source-inputs"), lock);
  const toyboxSource = join(stage, "toybox"); await mkdir(toyboxSource);
  const toyboxArchive = join(cache, "inputs/toybox-0.8.15.tar.gz");
  assert(digest(await readFile(toyboxArchive)) === "44e2bab43dfe2c171743297631ce558c6d9ed38b87a66fd751cef617574b375e", "Toybox source changed");
  await run("tar", ["-xzf", toyboxArchive, "-C", toyboxSource, "--strip-components=1", "--no-same-owner"], { timeout: 120_000 });
  const supplementSources = new Map<string, string>();
  const inputValue: unknown = JSON.parse(await readFile(join(recipe, "inputs.lock.json"), "utf8")); assert(Array.isArray(inputValue));
  for (const supplement of supplements) {
    const material = materials.get(supplement.name);
    if (material !== undefined) {
      supplementSources.set(supplement.name, supplement.name === "gcc-runtime" ? join(material.source, "libgcc") : material.source);
      continue;
    }
    const source = join(stage, supplement.name); await mkdir(source);
    const archive = join(cache, "inputs", supplement.archive), bytes = await readFile(archive);
    const pin = Array.from<unknown>(inputValue).find(value => typeof value === "object" && value !== null && "name" in value && value.name === supplement.archive);
    assert(typeof pin === "object" && pin !== null && "sha256" in pin && pin.sha256 === digest(bytes), "Supplement source differs from its immutable lock");
    await run("tar", ["-xzf", archive, "-C", source, "--strip-components=1", "--no-same-owner"], { timeout: 120_000 });
    supplementSources.set(supplement.name, supplement.subdir === "" ? source : join(source, supplement.subdir));
  }
  const out = join(cache, "evidence"); await mkdir(join(out, "licenses"), { recursive: true }); await mkdir(join(out, "sources"), { recursive: true });
  const notices: { readonly packageId: string; readonly license: string; readonly text: string }[] = [];
  const sourceRecords: { readonly packageId: string; readonly kind: "source"; readonly archive: { readonly path: string; readonly sha256: string }; readonly buildInstructionsFile: string }[] = [];
  const relationships: { readonly spdxElementId: string; readonly relationshipType: "CONTAINS"; readonly relatedSpdxElement: string }[] = [];
  for (const component of components) {
    const id = componentId(component.name), material = materials.get(component.name);
    const supplementSource = supplementSources.get(component.name);
    let notice = supplementSource !== undefined ? await licenseNotices(supplementSource) : component.name === "toybox" ? await licenseNotices(toyboxSource)
      : material === undefined ? await readFile(join(repository, "LICENSE"), "utf8") + await readFile(join(repository, "NOTICE"), "utf8") : await licenseNotices(material.source);
    if (component.name === "gcc-runtime") {
      assert(material !== undefined);
      notice += await readFile(join(material.source, "COPYING3"), "utf8");
      notice += await readFile(join(material.source, "COPYING.RUNTIME"), "utf8");
    }
    if (component.name === "dash") {
      notice = await readFile(join(stage, "utilities/dash/runtime-notices.txt"), "utf8") + await readFile(join(repository, "LICENSE"), "utf8");
      assert(!/GNU (?:Lesser )?General Public License/u.test(notice), "GPL generator leaked into dash runtime notices");
      assert((await readFile(join(stage, "utilities/dash/signames.c"))).equals(await readFile(join(recipe, "dash-signames.c"))), "Dash signal table changed");
      assert(!(await readFile(join(stage, "utilities/dash/link.map"), "utf8")).includes("mksignames"), "Dash links the GPL generator");
    }
    notices.push({ packageId: id, license: component.license, text: notice });
    await writeFile(join(out, "licenses", `${component.name}.txt`), notice);
    const sourceRoot = join(stage, "packages", `${component.name}-${component.version}`); await mkdir(sourceRoot, { recursive: true });
    const included = lock.sources.filter(source => source.name === component.name);
    for (const input of included) {
      const entry = materials.get(input.name); assert(entry !== undefined);
      await mkdir(join(sourceRoot, "upstream"), { recursive: true }); await mkdir(join(sourceRoot, "aports"), { recursive: true });
      await copyFile(entry.upstream, join(sourceRoot, "upstream", input.file));
      await cp(entry.recipe, join(sourceRoot, "aports", input.name), { recursive: true, verbatimSymlinks: true });
    }
    if (component.name === "oxidevm-starter-files" || component.name === "toybox" || supplementSources.has(component.name)) for (const name of ["Dockerfile", ".dockerignore", "components.json", "prepare.ts", "inputs.lock.json", "build-toybox.sh", "build-dash.sh", "dash-signames.c", "build-supplements.sh", "supplements.json", "test-utilities.sh"]) await copyFile(join(recipe, name), join(sourceRoot, name));
    const supplement = supplements.find(item => item.name === component.name);
    if (supplement !== undefined && material === undefined) {
      await copyFile(join(cache, "inputs", supplement.archive), join(sourceRoot, supplement.archive));
      if (component.name !== "dash") for (const name of ["xz.config.h", "libarchive.config.h", "dropbear.config.h", "curl.config.h"]) await copyFile(join(stage, "utilities", name), join(sourceRoot, name));
    }
    if (component.name === "dash") {
      await copyFile(join(cache, "inputs/dash-build-only-GPL-2.0.txt"), join(sourceRoot, "UPSTREAM-BUILD-ONLY-GPL-2.0.txt"));
      await cp(join(stage, "utilities/dash"), join(sourceRoot, "build-evidence"), { recursive: true });
      await rm(join(sourceRoot, "build-evidence/sh"));
    }
    if (component.name === "toybox") {
      await copyFile(toyboxArchive, join(sourceRoot, "toybox-0.8.15.tar.gz"));
      await copyFile(join(stage, "utilities/toybox.config"), join(sourceRoot, "toybox.config"));
      await copyFile(join(stage, "utilities/toybox.commands"), join(sourceRoot, "toybox.commands"));
      for (const name of ["toybox.build.sh", "toybox.libraries.txt", "toybox.hash-tests.txt"]) await copyFile(join(stage, "utilities", name), join(sourceRoot, name));
    }
    await writeFile(join(sourceRoot, "LICENSES.txt"), notice);
    for (const name of ["LICENSE", "NOTICE"]) await copyFile(join(repository, name), join(sourceRoot, `${name}.OXIDEVM`));
    const instructions = `# Build ${component.name} ${component.version}\n\nImage: oxidevm-starter-nginx ${imageVersion}.\nSource date epoch: ${epoch}.\n\nThe upstream archives and exact Alpine APKBUILD, configuration, patches and install scripts are included. Verify SHA256SUMS before use. The unchanged guest executables come from the immutable Alpine image and the pinned APK inputs recorded in the recipe.\n\nFor Alpine packages, extract the upstream archives into the abuild distfile cache, copy the supplied aports directory into a Linux x86-64 Alpine build environment, and run abuild -r from that package directory. mksh retains its exact Alpine recipe and source. Toybox includes the upstream archive, complete configuration, command list, pinned build inputs, Dockerfile and build script. Run prepare.ts, then docker build; no build tools are copied into the final scratch image. musl is supplied separately and its source is included. The dash build replaces the GPL signal-name generator and its output with the included independently authored Apache-2.0 Linux x86-64 musl ABI table. The GPL generator and pre-generated signal source are removed before configuration. Runtime headers, source checksums and the linker map accompany it. The full upstream archive retains its original build-only licenses. No other Spacia patches are applied. The guest image recipe copies the resulting executables; it does not modify them.\n\nUse the public image recipe to rebuild the final image. Toolchain versions and the practical rebuild log are retained with the release evidence. Image reproducibility and human legal approval are separate release gates.\n`;
    const buildFile = join(out, "sources", `${component.name}-${component.version}.BUILD.md`); await writeFile(buildFile, instructions); await writeFile(join(sourceRoot, "BUILD.md"), instructions);
    await writeFile(join(sourceRoot, "SHA256SUMS"), (await checksums(sourceRoot)).join(""));
    const archive = join(out, "sources", `${component.name}-${component.version}.tar.gz`);
    await run("tar", ["--create", "--gzip", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--file", archive, "--directory", sourceRoot, "."], { timeout: 120_000 });
    sourceRecords.push({ packageId: id, kind: "source", archive: { path: relative(recipe, archive), sha256: digest(await readFile(archive)) }, buildInstructionsFile: relative(recipe, buildFile) });
    for (const file of files) if (file.owner === component.name || supplement?.files.includes(file.path) === true) relationships.push({ spdxElementId: id, relationshipType: "CONTAINS", relatedSpdxElement: fileId(file.path) });
  }
  const sbom = { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", dataLicense: "CC0-1.0", name: `oxidevm-starter-nginx-${imageVersion}`, documentNamespace: `https://oxidevm.dev/sbom/nginx/${digest(JSON.stringify(files))}`, creationInfo: { creators: ["Tool: oxidevm-image-inventory"], created: new Date(epoch * 1000).toISOString() },
    packages: components.map(component => ({ SPDXID: componentId(component.name), name: component.name, versionInfo: component.version, downloadLocation: lock.sources.find(source => source.name === component.name)?.url ?? "NOASSERTION", filesAnalyzed: false, licenseConcluded: component.license, licenseDeclared: component.license, copyrightText: "See accompanying component notices" })),
    files: files.map(file => ({ SPDXID: fileId(file.path), fileName: file.path, checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }, { algorithm: "SHA1", checksumValue: file.sha1 }] })), relationships };
  await writeFile(join(out, "sbom.spdx.json"), doc(sbom));
  await writeFile(join(out, "sbom.cdx.json"), doc({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "operating-system", name: "oxidevm-starter-nginx", version: imageVersion } }, components: components.map(component => ({ type: "library", name: component.name, version: component.version, "bom-ref": componentId(component.name), licenses: [{ expression: component.license }], purl: `pkg:generic/${component.name}@${component.version}` })) }));
  await writeFile(join(out, "inventory.json"), doc({ schemaVersion: 1, files })); await copyFile(join(stage, "apk-installed.txt"), join(out, "apk-installed.txt"));
  await writeFile(join(out, "notices.json"), doc({ schemaVersion: 1, notices })); await writeFile(join(out, "sources.json"), doc({ schemaVersion: 1, packages: sourceRecords }));
  await writeFile(join(out, "policy.json"), doc({ schemaVersion: 2, purpose: "technical-inventory", validator: "oxidevm pinned Alpine file inventory", policySHA256: digest(canonicalPolicy), packages: notices.map(notice => ({ packageId: notice.packageId, license: notice.license, noticeSHA256: digest(notice.text), obligations: "source" })) }));
  await writeFile(join(out, "OPEN-SOURCE-NOTICE.md"), `# OxideVM nginx starter image\n\nThis image is a collection of separately licensed programs. Their licenses permit commercial use subject to their conditions. The SDK and application code are Apache-2.0. The OxideVM engine is separate proprietary software, free for non-commercial use and separately licensed for commercial production use. Engine terms do not limit rights under the image components' licenses.\n\nThe complete notices are in licenses/. Exact source archives and build instructions are in sources/. Toybox uses 0BSD. The interactive mksh shell uses MirOS AND Unicode-DFS-2016. The scripting dash shell uses BSD-3-Clause AND Apache-2.0 with an independently authored signal table. The GPL signal generator and its output are excluded from the runtime build. XZ core, libarchive ZIP extraction, dc, Dropbear and curl supplement missing Toybox functions. Nested libraries and the Mozilla certificate collection retain their separate licenses. GCC runtime objects retain GPL-3.0-or-later WITH GCC-exception-3.1 and musl startup objects retain MIT. The compiler remains build-only. Their original source notices, configuration and build inputs are included. BusyBox is not included. Users can modify, rebuild, sign and run images with their own keys. No Bun, Node.js or Linux kernel is included.\n\nThe inventory and source checks are technical evidence. Human legal review and owner release approval remain separate requirements.\n`);
  await writeFile(join(out, "SHA256SUMS"), (await checksums(out)).join(""));
  await rm(stage, { recursive: true, force: true }); process.stdout.write(`Prepared technical compliance materials: ${out}\n`); return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { assert(process.argv.length === 2, "Usage: node image/compliance.ts"); await prepareCompliance(); }
