/** Keep URL directory resolution separate from Vite's static asset rewriting. */
export function doctorAssetBase(scriptURL: string): URL { return new URL("../", new URL(scriptURL)); }

/** Match the preview keeper's deployed isolation contract, including host-scoped development. */
export function doctorPreviewFrame(origin: string, parentOrigin: string, session: string): { readonly url: string; readonly origin: string } {
  const preview = new URL(origin); const parent = new URL(parentOrigin);
  const shared = preview.hostname === parent.hostname;
  if (!shared) preview.hostname = `${session}.${preview.hostname}`;
  preview.pathname = "/__oxidevm/index.html";
  preview.searchParams.set("session", session); preview.searchParams.set("parentOrigin", parent.origin);
  if (shared) preview.searchParams.set("isolation", "shared");
  return { url: preview.href, origin: preview.origin };
}
