// The SDK and CLI archives that `pnpm pack --pack-destination .candidate` produces. Their file names carry
// the packages' versions, so scripts derive them from the manifests instead of spelling a version out.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";

export interface PackedArchives {
  readonly sdk: string;
  readonly cli: string;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const ARCHIVE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

/** The file name `pnpm pack` gives a package: the scope's "@" is dropped and its "/" becomes "-". */
export function archiveFileName(name: string, version: string): string {
  if (!PACKAGE_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a usable package name`);
  if (!ARCHIVE_VERSION.test(version)) throw new Error(`${JSON.stringify(version)} is not a usable archive version`);
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

async function archivePath(root: string, directory: string): Promise<string> {
  const label = `${directory}/package.json`;
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")); }
  catch (error: unknown) { throw new Error(`${label} cannot be read as JSON`, { cause: error }); }
  const manifest = record(value, label);
  return join(root, ".candidate", archiveFileName(string(manifest["name"], `${label} name`), string(manifest["version"], `${label} version`)));
}

/** Absolute paths in `<root>/.candidate` of the archives for the packages' current versions. */
export async function packedArchives(root: string): Promise<PackedArchives> {
  const [sdk, cli] = await Promise.all([archivePath(root, "packages/sdk"), archivePath(root, "packages/cli")]);
  return { sdk, cli };
}
