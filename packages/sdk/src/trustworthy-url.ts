/** Secure transport, or an origin browsers treat as trustworthy localhost development. */
export function isTrustworthyURL(url: URL, secure = "https:", insecure = "http:"): boolean {
  return url.protocol === secure || url.protocol === insecure && (
    url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname)
  );
}
