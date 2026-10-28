import { Buffer } from "buffer";
import { exactKeys, record } from "../../decode.js";
import { decodeHttp2Settings, http2Failure } from "./node-http2-wire.js";

/** Secrets use the helper's stdin, never its command line or environment. */
export function http2Options(value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value, "HTTP/2 options");
  exactKeys(source, [], ["ca", "key", "cert", "passphrase", "servername", "rejectUnauthorized", "ALPNProtocols", "minVersion", "maxVersion", "settings", "allowHTTP1", "host"]);
  const result: Record<string, unknown> = {};
  for (const name of ["ca", "key", "cert"] as const) {
    const item = source[name]; if (item === undefined) continue;
    if (typeof item !== "string" && !(item instanceof Uint8Array)) throw new TypeError(`HTTP/2 ${name} requires PEM bytes`);
    const bytes = typeof item === "string" ? Buffer.from(item) : Buffer.from(item);
    if (bytes.length > 32768) throw http2Failure("ERR_OUT_OF_RANGE", "HTTP/2 identity exceeds its 32 KiB limit");
    result[name] = bytes.toString("base64");
  }
  for (const name of ["passphrase", "servername", "host"] as const) {
    const item = source[name]; if (item === undefined) continue;
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > 4096) throw new TypeError(`Invalid HTTP/2 ${name}`);
    result[name] = item;
  }
  if (source["rejectUnauthorized"] !== undefined) {
    if (typeof source["rejectUnauthorized"] !== "boolean") throw new TypeError("Invalid HTTP/2 certificate policy");
    result["rejectUnauthorized"] = source["rejectUnauthorized"];
  }
  if (source["allowHTTP1"] !== undefined && source["allowHTTP1"] !== false) throw http2Failure("ERR_FEATURE_UNAVAILABLE", "HTTP/1 fallback on an HTTP/2 listener is not supported");
  for (const name of ["minVersion", "maxVersion"] as const) {
    const item = source[name]; if (item === undefined) continue;
    if (typeof item !== "string" || !["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"].includes(item)) throw new TypeError("Invalid TLS version");
    result[name] = item;
  }
  if (source["ALPNProtocols"] !== undefined) {
    const items = source["ALPNProtocols"];
    if (!Array.isArray(items) || items.length > 32) throw new TypeError("Invalid HTTP/2 ALPN protocols");
    result["ALPNProtocols"] = items.map((item: unknown) => {
      if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > 255) throw new TypeError("Invalid HTTP/2 ALPN protocol"); return item;
    });
  }
  if (source["settings"] !== undefined) result["settings"] = decodeHttp2Settings(source["settings"]);
  return result;
}

export function http2Authority(value: unknown): string {
  if (!(typeof value === "string" || value instanceof URL)) throw new TypeError("HTTP/2 authority requires a URL");
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || Buffer.byteLength(url.href) > 4096) throw http2Failure("ERR_HTTP2_UNSUPPORTED_PROTOCOL", "Invalid HTTP/2 authority");
  return url.href;
}
