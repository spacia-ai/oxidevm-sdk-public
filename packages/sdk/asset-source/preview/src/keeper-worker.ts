/** The session's Service Worker: a classic script under the preview base, in development as in builds. */
export const PREVIEW_WORKER_URL = "/__oxidevm/sw.js";

/** Registers the session worker for the whole origin (the response allows scope "/"). */
export function registerPreviewWorker<T>(container: { register(url: string, options: { readonly scope: string }): Promise<T> }): Promise<T> {
  return container.register(PREVIEW_WORKER_URL, { scope: "/" });
}
