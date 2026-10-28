import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BuildImageOptions, ImageRecipe } from "./contracts.js";
import { VMError } from "../runtime/errors.js";
import { abortIfRequested } from "./tools.js";

export async function canonicalOutputPath(path: string): Promise<string> {
  const suffix: string[] = []; let parent = resolve(path);
  for (;;) {
    try { return resolve(await realpath(parent), ...suffix); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw new VMError("INVALID_ARGUMENT", "image path cannot be resolved safely");
      const next = dirname(parent); if (next === parent) throw new VMError("INVALID_ARGUMENT", "image path has no existing parent");
      suffix.unshift(relative(next, parent)); parent = next;
    }
  }
}
export function containsPath(parent: string, path: string): boolean {
  const offset = relative(parent, path);
  return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/** Both purposes share this guard, before any builder or atomic replacement runs. */
export async function validateOutputPath(recipe: ImageRecipe, options: BuildImageOptions): Promise<string> {
  abortIfRequested(options.signal);
  const directory = resolve(options.recipeDir); const out = await canonicalOutputPath(resolve(directory, options.outDir ?? "dist"));
  const protectedPaths = [directory, resolve(directory, options.signingKeyFile)];
  const source = recipe.source;
  switch (source.kind) {
    case "directory": {
      const input = await canonicalOutputPath(resolve(directory, source.path));
      if (containsPath(input, out)) throw new VMError("INVALID_ARGUMENT", "output must be outside the input rootfs");
      protectedPaths.push(input); break;
    }
    case "archive": protectedPaths.push(resolve(directory, source.artifact.path)); break;
    case "dockerfile": protectedPaths.push(resolve(directory, source.context), resolve(directory, source.file)); break;
    case "boot-files": protectedPaths.push(resolve(directory, source.kernel.path), resolve(directory, source.disk.path));
      if (source.initrd !== undefined) protectedPaths.push(resolve(directory, source.initrd.path)); break;
    case "oci": break;
  }
  if (recipe.mode === "system" && "boot" in recipe) {
    if (recipe.boot.kernel.kind === "file") protectedPaths.push(resolve(directory, recipe.boot.kernel.artifact.path));
    if (recipe.boot.initrd !== undefined) protectedPaths.push(resolve(directory, recipe.boot.initrd.path));
  }
  const evidence = recipe.evidence;
  if (evidence !== undefined) {
    if (evidence.sbom.kind === "file") protectedPaths.push(resolve(directory, evidence.sbom.path));
    protectedPaths.push(...[evidence.noticesFile, evidence.correspondingSourcesFile, evidence.licensePolicyFile].map(path => resolve(directory, path)));
  }
  for (const secret of options.secrets ?? []) protectedPaths.push(resolve(directory, secret.file));
  for (const path of protectedPaths) {
    abortIfRequested(options.signal);
    if (containsPath(out, await canonicalOutputPath(path))) throw new VMError("INVALID_ARGUMENT", "output must not replace the recipe, input, evidence or signing key");
  }
  return out;
}
