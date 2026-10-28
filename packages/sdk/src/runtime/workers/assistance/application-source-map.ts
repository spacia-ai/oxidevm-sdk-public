import { Buffer } from "buffer";
import { record } from "../../decode.ts";
import { VMError } from "../../errors.ts";
import { createNodeUrl, fileURLToPath } from "./node-url.ts";
import { SourceMap } from "./node-source-map.ts";

const urls = createNodeUrl(() => "/");
const NativeURL = URL;
const MAX_MAP_CHARACTERS = 16 * 1024 * 1024;

/** Application maps are optional metadata. Reads stay with the Linux file
 * owner; URL schemes never grant an application an independent fetch path. */
export function loadApplicationSourceMap(path: string, source: string, read: (path: string) => string): SourceMap | undefined {
  let reference: string | undefined;
  for (const match of source.matchAll(/\/[/*]#\s+sourceMappingURL=(\S+)/gu)) reference = match[1];
  if (reference === undefined) return undefined;
  try {
    const moduleURL = NativeURL.parse(path) ?? urls.pathToFileURL(path);
    const absolute = NativeURL.parse(reference);
    let text: string; let base: URL;
    if (absolute !== null) {
      if (absolute.protocol !== "data:") return undefined;
      const comma = absolute.pathname.indexOf(",");
      if (comma === -1) return undefined;
      const format = absolute.pathname.slice(0, comma).split(";");
      if (format[0] !== "application/json") return undefined;
      const content = absolute.pathname.slice(comma + 1);
      bounded(content);
      text = format.at(-1) === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
      base = moduleURL;
    } else {
      base = new NativeURL(reference, moduleURL);
      text = read(fileURLToPath(base));
    }
    bounded(text);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const payload = record(value, "application source map");
    const sources = payload["sources"];
    if (!Array.isArray(sources)) return undefined;
    const root = payload["sourceRoot"] ?? "";
    if (typeof root !== "string") return undefined;
    const originalSources: readonly unknown[] = sources;
    const resolved = originalSources.map(value => {
      if (typeof value !== "string" && value !== null) throw new TypeError("Invalid source-map source");
      const original = root + String(value);
      return original.startsWith("/") ? urls.pathToFileURL(original).href : new NativeURL(original, base).href;
    });
    return new SourceMap({ ...payload, sources: resolved, sourceRoot: "" }, {
      lineLengths: source.split(/[\n\u2028\u2029]/u).map(line => line.length),
    });
  } catch (error) {
    // Do not disguise exhausted budgets or failed transport/authority as absent
    // optional metadata. Ordinary malformed or missing maps match Node's miss.
    if (error instanceof VMError) throw error;
    return undefined;
  }
}

function bounded(text: string): void {
  if (text.length > MAX_MAP_CHARACTERS) throw new VMError("QUOTA_EXCEEDED", "Application source-map budget exhausted", { api: "module.findSourceMap" });
}
