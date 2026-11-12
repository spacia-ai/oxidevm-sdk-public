import { describe, expect, it } from "vitest";

import { websocketRoute } from "./websocket-route";

const PAGE = { href: "https://0123456789abcdef0123456789abcdef.oxvm.dev/app", hostname: "0123456789abcdef0123456789abcdef.oxvm.dev" };

describe("websocketRoute", () => {
  it("bridges sockets to the page's own host", () => {
    expect(websocketRoute(`wss://${PAGE.hostname}/hmr`, PAGE)).toBe("bridge");
  });

  it("leaves sockets to other hosts to the browser and the CSP", () => {
    expect(websocketRoute("wss://realtime.example.com/socket", PAGE)).toBe("native");
  });

  it("rejects credentials, other schemes and hashes", () => {
    for (const url of ["wss://u:p@x.example.com", "https://x.example.com", `wss://${PAGE.hostname}/a#h`]) {
      expect(() => websocketRoute(url, PAGE)).toThrow(expect.objectContaining({ name: "SecurityError" }));
    }
  });
});
