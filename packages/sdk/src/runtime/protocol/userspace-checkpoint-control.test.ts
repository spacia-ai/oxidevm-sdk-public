import { expect, it } from "vitest";
import { controlResponseDecoders, decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.js";

it("validates native startup and durable-flush control requests at the common boundary", () => {
  const mount = { rootTreeSha256: "a".repeat(64), workspaceBaseSha256: "b".repeat(64), cpuProfile: "x86-64-v2", rootfs: new Uint8Array(4) };
  const configure = { id: 1, version: PROTOCOL_VERSION, type: "configure-userspace-checkpoints", mount,
    destination: { manifestUrl: "https://example.test/rootfs.json", trusted: { keyId: "test", publicKey: new Uint8Array(32) } } };
  expect(decodeControlIncoming(configure)).toEqual(configure);
  const restore = { id: 2, version: PROTOCOL_VERSION, type: "restore-userspace-checkpoint",
    snapshot: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-13T10:00:00.000Z" },
    replacedId: "123e4567-e89b-42d3-a456-426614174002" };
  expect(decodeControlIncoming(restore)).toEqual(restore);
  for (const input of [{ ...configure, extra: 1 }, { ...configure, mount: {} }, { ...restore, replacedId: "latest" }]) {
    expect(() => decodeControlIncoming(input)).toThrow();
  }
  expect(decodeControlIncoming({ id: 3, version: PROTOCOL_VERSION, type: "flush-userspace" })).toMatchObject({ type: "flush-userspace" });
  expect(() => { controlResponseDecoders["flush-userspace"](undefined); }).not.toThrow();
});
