/** The body the preview forwards; the browser owns the Request and its stream. */
export function previewRequestBody(request: Request): ReadableStream<Uint8Array> | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  // Firefox may omit this API. Buffering the entire upload would bypass streaming bounds.
  const body: unknown = request.body;
  if (body === undefined) throw new TypeError("This browser does not expose streaming request bodies");
  return request.body;
}
