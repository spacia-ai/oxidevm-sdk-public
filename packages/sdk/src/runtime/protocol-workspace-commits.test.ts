import { expect, it } from "vitest";
import { VMError } from "./errors.js";
import { decodeStorageIncoming, decodeControlIncoming, PROTOCOL_VERSION } from "./protocol.js";

  it("strictly decodes cross-mode workspace commits", () => {
    expect(decodeStorageIncoming({
      id: 31,
      version: PROTOCOL_VERSION,
      type: "commit-workspace-snapshot",
      workspaceBaseSha256: "a".repeat(64),
      data: new Uint8Array([1, 2]),
    })).toMatchObject({ type: "commit-workspace-snapshot" });
    expect(() => decodeStorageIncoming({
      id: 32,
      version: PROTOCOL_VERSION,
      type: "commit-workspace-snapshot",
      workspaceBaseSha256: "bad",
      data: new Uint8Array(),
      extra: true,
    })).toThrow(VMError);
    expect(decodeControlIncoming({
      id: 33,
      version: PROTOCOL_VERSION,
      type: "agent-apply-workspace",
      data: new Uint8Array([79, 88, 82, 70]),
    })).toMatchObject({ type: "agent-apply-workspace" });
    expect(decodeStorageIncoming({
      id: 34,
      version: PROTOCOL_VERSION,
      type: "read-workspace-snapshot",
      workspaceBaseSha256: "b".repeat(64),
    })).toMatchObject({ type: "read-workspace-snapshot" });
  });
