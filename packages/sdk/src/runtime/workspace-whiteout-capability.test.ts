import { expect, it } from "vitest";
import { requireKnownAgentCapabilities } from "./agent-protocol.js";
import { requireWorkspaceDialect } from "./workspace-record.js";

it("requires the whiteout guest capability before handing over its record format", () => {
  for (const [magic, version] of [["OXRF", 10], ["OXWD", 5]] as const) {
    const bytes = new Uint8Array(12); bytes.set(new TextEncoder().encode(magic));
    new DataView(bytes.buffer).setUint16(4, version, true);
    expect(() => requireWorkspaceDialect(bytes, 7, magic, 4096)).toThrow(/whiteout/u);
    expect(() => requireWorkspaceDialect(bytes, 7, magic, 4096 | 8192)).not.toThrow();
  }
  expect(() => requireKnownAgentCapabilities(8191 | 8192, 7)).not.toThrow();
  expect(() => requireKnownAgentCapabilities(8192, 6)).toThrow();
});
