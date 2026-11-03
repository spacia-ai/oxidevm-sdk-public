import type { LinuxSocketAddress } from "../../js-process-types.js";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;

export function isIPv4(text: string): boolean { return IPV4.test(text); }

/** A numeric IPv6 address without a zone, in any of its textual forms (RFC 4291 section 2.2). */
export function isIPv6(text: string): boolean {
  if (!text.includes(":") || text.includes("%")) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | null => {
    if (part === "") return [];
    const items = part.split(":"), last = items.at(-1) ?? "";
    const words = isIPv4(last) ? [...items.slice(0, -1), "0", "0"] : items;
    return words.every(word => /^[0-9a-f]{1,4}$/iu.test(word)) ? words : null;
  };
  const left = groups(halves[0] ?? ""), right = groups(halves[1] ?? "");
  if (left === null || right === null) return false;
  const count = left.length + right.length;
  return halves.length === 1 ? count === 8 : count <= 7;
}

export function isAddressLiteral(text: string): boolean { return isIPv4(text) || isIPv6(text); }

export function addressFamily(address: string): "ipv4" | "ipv6" { return isIPv6(address) ? "ipv6" : "ipv4"; }

export function socketAddress(address: string, port: number): LinuxSocketAddress {
  return { family: addressFamily(address), address, port };
}

/** The host part of a URL without IPv6 brackets. */
export function urlHost(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}
