import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeNetworkControlConnection } from "./network.js";

function message(fields: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { version: PROTOCOL_VERSION, type: "connect-network-control", port: new MessageChannel().port1, origin: "https://run.oxidevm.dev", workspaceId: "default", pageUrl: "https://run.oxidevm.dev/v/0.1.0/", serverAllowed: true, ...fields };
}

describe("network control connection", () => {
  it("decodes a self-hosted page's relay scope, which names no embedding page", () => {
    const decoded = decodeNetworkControlConnection(message({ origin: "https://app.example", pageUrl: "https://app.example/editor" }));
    expect(decoded.scope).toEqual({ origin: "https://app.example", workspaceId: "default", serverAllowed: true });
    expect(decoded.pageUrl).toBe("https://app.example/editor");
    expect(decoded.port).toBeInstanceOf(MessagePort);
  });
  it("decodes the page that embeds the runtime frame", () => {
    expect(PROTOCOL_VERSION).toBe(181);
    expect(decodeNetworkControlConnection(message({ embedderOrigin: "https://one.example", workspaceName: "My project", serverAllowed: false })).scope)
      .toEqual({ origin: "https://run.oxidevm.dev", workspaceId: "default", embedderOrigin: "https://one.example", workspaceName: "My project", serverAllowed: false });
  });
  it("rejects an embedding page that is not the serialized origin of another document", () => {
    for (const embedderOrigin of ["null", "https://one.example/", "https://one.example/app", "HTTPS://ONE.EXAMPLE", "one.example", "", 7, "https://run.oxidevm.dev"]) {
      expect(() => decodeNetworkControlConnection(message({ embedderOrigin })), String(embedderOrigin)).toThrow();
    }
  });
  it("rejects unknown fields, a page outside its origin, a non-boolean relay policy and a missing port", () => {
    expect(() => decodeNetworkControlConnection(message({ embedder: "https://one.example" }))).toThrow();
    expect(() => decodeNetworkControlConnection(message({ pageUrl: "https://one.example/" }))).toThrow();
    expect(() => decodeNetworkControlConnection(message({ origin: "null", pageUrl: "null" }))).toThrow();
    expect(() => decodeNetworkControlConnection(message({ serverAllowed: "yes" }))).toThrow();
    expect(() => decodeNetworkControlConnection(message({ port: {} }))).toThrow();
  });
});
