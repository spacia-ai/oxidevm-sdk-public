import type { WasmBuildResult } from "@oxidevm/sdk/image-builder";

/** A word for a shell command line: left alone when it is plainly safe, single-quoted otherwise. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._/@:+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The commands that publish a finished build: tag, draft with every file, download and check the draft against its own
 * SHA256SUMS, publish, and the line that installs it. Publishing changes what other people can install, so these are
 * printed for the author to run (or for the release workflow to run), never executed here.
 */
export function releasePlan(build: WasmBuildResult, options: { readonly repo?: string; readonly directory: string }): { readonly tag: string | null; readonly steps: readonly string[] } {
  if (build.result === "failed" || build.version === null || build.release === null) return { tag: null, steps: [] };
  const tag = `v${build.version}`, repo = options.repo ?? "OWNER/REPO", on = options.repo === undefined ? "" : ` --repo ${shellWord(options.repo)}`;
  const files = `${shellWord(options.directory)}/*`;
  return {
    tag,
    steps: [
      `1. Commit your changes, then tag the release:\n   git tag ${shellWord(tag)} && git push origin ${shellWord(tag)}`,
      `2. Draft the release with every file of the build:\n   gh release create ${shellWord(tag)} ${files} --draft --verify-tag --title ${shellWord(tag)} --generate-notes${on}`,
      `3. Download the draft and check it against its own SHA256SUMS:\n   mkdir verify && gh release download ${shellWord(tag)} --dir verify${on}\n   (cd verify && sha256sum --check SHA256SUMS && sha256sum SHA256SUMS)\n   The last digest must be the release id, ${build.release}.`,
      `4. Publish it:\n   gh release edit ${shellWord(tag)} --draft=false${on}`,
      `5. Anyone can now install it:\n   oxidevm wasm add github:${repo}@${tag}`,
    ],
  };
}
