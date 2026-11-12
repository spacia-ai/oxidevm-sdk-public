// Which socket a preview page's WebSocket constructor opens: the bridge to the guest for this
// page's own host, or the browser's own socket for any other host, where the CSP decides.

export function websocketRoute(
  url: string | URL,
  page: { readonly href: string; readonly hostname: string },
): "bridge" | "native" {
  const target = new URL(url, page.href);
  if ((target.protocol !== "ws:" && target.protocol !== "wss:") || target.username !== "" || target.password !== "" || target.hash !== "") {
    throw new DOMException("Unsafe preview WebSocket URL", "SecurityError");
  }
  return target.hostname === page.hostname ? "bridge" : "native";
}
