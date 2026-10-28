// Third-party license policy for the SDK repository. The allowlists are copies of the engine
// repository's config/allowed-licenses.json (everything that ships in a package or sample) and
// config/allowed-tool-licenses.json (build-only tooling, never distributed). First-party code is
// Apache-2.0 (Spacia B.V.) and is not judged against them.
//
// The inventory is two filtered pnpm listings rather than one unfiltered listing. Production
// (`--prod`: dependencies and optionalDependencies of every workspace project) is checked against
// the platform list; whatever only `--dev` reaches is checked against the platform list plus the
// tool list. pnpm's unfiltered listing also resolves optional platform packages that this install
// skipped (for example because the running Node.js does not satisfy their `engines` range) and then
// fails with ERR_PNPM_MISSING_PACKAGE_INDEX_FILE, so it is not a stable input. Optional platform
// binaries that only a development tool reaches (esbuild, rollup) are outside `--dev` and unchecked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { licenseAllowed } from "./license-expression.ts";
import { verifyLicensePolicy } from "./license-policy.ts";

interface InventoryPackage {
  readonly name: string;
  readonly versions: readonly string[];
  /** Installed locations reported by pnpm; they tell this checkout's own packages from installed ones. */
  readonly paths: readonly string[];
}

/** License expression to the packages declaring it, as `pnpm licenses list --json` reports them. */
type Inventory = ReadonlyMap<string, readonly InventoryPackage[]>;

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
await verifyLicensePolicy(root);
const LICENSE_IDENTIFIER = /^[A-Za-z0-9.+-]+(?: WITH [A-Za-z0-9.+-]+)?$/u;
const FIRST_PARTY_NAME = /^(?:oxidevm-sdk-workspace|@oxidevm\/[^/]+|@oxidevm-example\/[^/]+)$/u;

const allowed: ReadonlySet<string> = new Set(await readAllowlist("config/allowed-licenses.json"));
const toolAllowed: ReadonlySet<string> = new Set([
  ...allowed,
  ...(await readAllowlist("config/allowed-tool-licenses.json")),
]);

selfCheck();

const [production, development] = await Promise.all([listLicenses("--prod"), listLicenses("--dev")]);
for (const [scope, inventory] of [["--prod", production], ["--dev", development]] as const) {
  // An uninstalled checkout lists nothing; that must not pass as "no unapproved licenses".
  if (versionKeys(inventory).size === 0) {
    throw new Error(`pnpm licenses list ${scope} reported no packages; run pnpm install --frozen-lockfile first`);
  }
}
const failures = licenseFailures(production, development, allowed, toolAllowed, root);
if (failures.length > 0) {
  console.error(`Unapproved dependency licenses:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  const distributed = versionKeys(production);
  const toolingOnly = [...versionKeys(development)].filter(key => !distributed.has(key));
  console.log(
    `${distributed.size} production and ${toolingOnly.length} development-only dependency versions use approved licenses`,
  );
}

async function readAllowlist(file: string): Promise<readonly string[]> {
  const parsed: unknown = JSON.parse(await readFile(resolve(root, file), "utf8"));
  const entries = textArray(parsed, file);
  for (const entry of entries) {
    // An entry the evaluator cannot match would silently approve nothing.
    if (!LICENSE_IDENTIFIER.test(entry)) {
      throw new TypeError(`${file} entry ${JSON.stringify(entry)} is not an SPDX license identifier`);
    }
  }
  return entries;
}

async function listLicenses(scope: "--prod" | "--dev"): Promise<Inventory> {
  const command = `pnpm licenses list ${scope} --json`;
  try {
    const { stdout } = await run("pnpm", ["licenses", "list", scope, "--json"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const parsed: unknown = JSON.parse(stdout);
    return decodeInventory(parsed, command);
  } catch (error: unknown) {
    throw new Error(`${command} failed: ${failureDetail(error)}`, { cause: error });
  }
}

function failureDetail(error: unknown): string {
  if (!isRecord(error)) return "unknown failure";
  const message = typeof error["message"] === "string" ? error["message"] : "unknown failure";
  // pnpm reports its own error as JSON on stdout, so the process output explains the failure.
  const output = [error["stdout"], error["stderr"]]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map(part => part.trim().slice(0, 2000));
  return [message, ...output].join("\n");
}

function decodeInventory(value: unknown, label: string): Inventory {
  const decoded = new Map<string, readonly InventoryPackage[]>();
  for (const [expression, packages] of Object.entries(record(value, label))) {
    if (expression.trim() === "") throw new TypeError(`${label} has an empty license expression`);
    decoded.set(
      expression,
      array(packages, `${label} license ${expression}`).map((item, index) => {
        const where = `${label} ${expression}[${index}]`;
        const dependency = record(item, where);
        const versions = textArray(dependency["versions"], `${where} versions`);
        if (versions.length === 0) throw new TypeError(`${where} must list at least one version`);
        return {
          name: text(dependency["name"], `${where} name`),
          versions,
          paths: dependency["paths"] === undefined ? [] : textArray(dependency["paths"], `${where} paths`),
        };
      }),
    );
  }
  return decoded;
}

function versionKeys(inventory: Inventory): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const packages of inventory.values()) {
    for (const dependency of packages) {
      for (const version of dependency.versions) keys.add(`${dependency.name}@${version}`);
    }
  }
  return keys;
}

/** A package of this checkout: first-party by name and located in the working tree, not in a
 * node_modules directory. The name alone never exempts, so a registry package that happens to
 * use a first-party scope is still judged by its license. */
function isFirstParty(dependency: InventoryPackage, repository: string): boolean {
  return (
    FIRST_PARTY_NAME.test(dependency.name) &&
    dependency.paths.length > 0 &&
    dependency.paths.every(path => isWorkspacePath(path, repository))
  );
}

function isWorkspacePath(path: string, repository: string): boolean {
  const location = relative(repository, resolve(repository, path));
  const outside = location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location);
  return location !== "" && !outside && !location.split(sep).includes("node_modules");
}

function licenseFailures(
  productionInventory: Inventory,
  developmentInventory: Inventory,
  platformLicenses: ReadonlySet<string>,
  toolLicenses: ReadonlySet<string>,
  repository: string,
): readonly string[] {
  const distributed = versionKeys(productionInventory);
  const failures: string[] = [];
  const judge = (inventory: Inventory, licenses: ReadonlySet<string>, scope: string): void => {
    for (const [expression, packages] of inventory) {
      for (const dependency of packages) {
        if (isFirstParty(dependency, repository) || licenseAllowed(expression, licenses)) continue;
        for (const version of dependency.versions) {
          // A package production also reaches was judged there, against the stricter list.
          if (scope === "development" && distributed.has(`${dependency.name}@${version}`)) continue;
          failures.push(`${dependency.name}@${version}: ${expression} (${scope})`);
        }
      }
    }
  };
  judge(productionInventory, platformLicenses, "production");
  judge(developmentInventory, toolLicenses, "development");
  return failures;
}

function selfCheck(): void {
  // The expression cases below are the engine repository's own, against the same allowlists.
  assert.equal(licenseAllowed("MIT AND Apache-2.0", allowed), true);
  assert.equal(licenseAllowed("MPL-2.0 OR Apache-2.0", allowed), true);
  assert.equal(licenseAllowed("(MIT OR MPL-2.0) AND Apache-2.0", allowed), true);
  assert.equal(licenseAllowed("(MIT OR Apache-2.0) AND GPL-3.0-only", allowed), false);
  assert.equal(licenseAllowed("MIT WITH unapproved-exception", allowed), false);
  assert.equal(licenseAllowed("MPL-2.0", allowed), false);
  assert.equal(licenseAllowed("MPL-2.0", toolAllowed), true);
  assert.equal(licenseAllowed("Apache-2.0", allowed), true, "the SDK's own license must stay allowed");
  assert.equal(licenseAllowed("Unknown", toolAllowed), false);

  const repository = "/work/sdk";
  const installed = (name: string): string => `${repository}/node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`;
  const listing = (expression: string, ...packages: readonly InventoryPackage[]): Inventory =>
    new Map([[expression, packages]]);
  const thirdParty = { name: "left-pad", versions: ["1.0.0"], paths: [installed("left-pad")] };
  const workspace = { name: "@oxidevm/sdk", versions: ["0.1.0"], paths: [`${repository}/packages/sdk`] };
  const registry = { name: "@oxidevm/sdk", versions: ["0.1.0"], paths: [installed("@oxidevm/sdk")] };
  const empty: Inventory = new Map();
  const failuresOf = (productionInventory: Inventory, developmentInventory: Inventory): readonly string[] =>
    licenseFailures(productionInventory, developmentInventory, allowed, toolAllowed, repository);

  assert.deepEqual(failuresOf(listing("MIT", thirdParty), empty), []);
  assert.deepEqual(failuresOf(listing("UNLICENSED", thirdParty), empty), ["left-pad@1.0.0: UNLICENSED (production)"]);
  // Tool-only licenses pass for development-only packages and fail for anything production reaches.
  assert.deepEqual(failuresOf(empty, listing("MPL-2.0", thirdParty)), []);
  assert.deepEqual(failuresOf(listing("MPL-2.0", thirdParty), listing("MPL-2.0", thirdParty)), [
    "left-pad@1.0.0: MPL-2.0 (production)",
  ]);
  // A first-party package in this working tree needs no allowlisted license; a registry copy does.
  assert.deepEqual(failuresOf(listing("UNLICENSED", workspace), empty), []);
  assert.deepEqual(failuresOf(listing("UNLICENSED", registry), empty), ["@oxidevm/sdk@0.1.0: UNLICENSED (production)"]);
  assert.deepEqual(failuresOf(listing("Apache-2.0", registry), empty), []);
  assert.deepEqual(failuresOf(listing("UNLICENSED", { ...workspace, paths: ["/elsewhere/packages/sdk"] }), empty), [
    "@oxidevm/sdk@0.1.0: UNLICENSED (production)",
  ]);
  assert.deepEqual(failuresOf(listing("UNLICENSED", { ...workspace, name: "left-pad" }), empty), [
    "left-pad@0.1.0: UNLICENSED (production)",
  ]);

  const decoded = decodeInventory(
    { MIT: [{ name: "example", versions: ["1.0.0"], paths: [installed("example")], license: "MIT", author: "A" }] },
    "fixture",
  );
  assert.deepEqual([...versionKeys(decoded)], ["example@1.0.0"]);
  assert.deepEqual(versionKeys(decodeInventory({ MIT: [{ name: "example", versions: ["1.0.0"] }] }, "fixture")), new Set(["example@1.0.0"]));
  assert.throws(() => decodeInventory([], "fixture"), /must be an object/u);
  assert.throws(() => decodeInventory({ MIT: {} }, "fixture"), /must be an array/u);
  assert.throws(() => decodeInventory({ MIT: [{ versions: ["1.0.0"] }] }, "fixture"), /name must be a non-empty string/u);
  assert.throws(() => decodeInventory({ MIT: [{ name: "example", versions: [] }] }, "fixture"), /at least one version/u);
  assert.throws(() => decodeInventory({ MIT: [{ name: "example", versions: [1] }] }, "fixture"), /versions\[0\] must be a non-empty string/u);
  assert.throws(() => decodeInventory({ MIT: [{ name: "example", versions: ["1"], paths: "x" }] }, "fixture"), /paths must be an array/u);
  assert.throws(() => decodeInventory({ "": [] }, "fixture"), /empty license expression/u);
  // pnpm's own failure document is an object whose values are not package lists.
  assert.throws(() => decodeInventory({ error: { code: "ERR_PNPM_MISSING_PACKAGE_INDEX_FILE" } }, "fixture"), /must be an array/u);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function textArray(value: unknown, label: string): readonly string[] {
  return array(value, label).map((item, index) => text(item, `${label}[${index}]`));
}
