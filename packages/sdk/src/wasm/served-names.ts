/** File names that development servers rewrite when serving them: scripts, stylesheets and pages. */
const REWRITTEN = /\.(?:[cm]?[jt]sx?|vue|marko|svelte|astro|imba|mdx|css|less|sass|scss|styl|stylus|pcss|postcss|sss|html?)$/iu;

/**
 * The name a staged file is served under. Vite's development server, for one, adds import analysis and hot-reload code to
 * `adapter.mjs`, so the bytes a page fetched would no longer match the pinned sha256. A staged release therefore also
 * holds a copy of each such file under a neutral name, and the generated handles point at the copy.
 */
export function servedName(name: string): string {
  return REWRITTEN.test(name) ? `${name}.bin` : name;
}

/** The files every staged release holds besides its artifacts; the adapter is a script, so it has a served copy too. */
const RELEASE_FILES: readonly string[] = ["module.json", "adapter.mjs", "adapter.mjs.bin", "SHA256SUMS"];

/**
 * The first artifact name that would end up as the same file as another: staging holds every artifact, the served copy of
 * each script, stylesheet and page, and the release's own files in one directory, and the file systems of macOS and
 * Windows ignore case. `undefined` when all of them are distinct.
 */
export function clashingFileName(artifactNames: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of [...RELEASE_FILES, ...artifactNames.flatMap(artifact => servedName(artifact) === artifact ? [artifact] : [artifact, servedName(artifact)])]) {
    const key = name.toLowerCase();
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return undefined;
}
