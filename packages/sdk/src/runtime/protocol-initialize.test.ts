import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import { decodeControlIncoming, PROTOCOL_VERSION } from "./protocol.js";

describe("control initialize request", () => {
  it("carries the VM's memory size, which restores are checked against", () => {
    const channel = new MessageChannel();
    const initialize = {
      id: 1,
      version: PROTOCOL_VERSION,
      type: "initialize",
      coreWasmUrl: "/oxidevm_core.wasm",
      sharedCoreWasmUrl: "/oxidevm_core_shared.wasm",
      workspaceId: "default",
      memoryMiB: 1536,
      vcpus: 2,
      snapshotPort: channel.port1,
    } as const;
    try {
      expect(decodeControlIncoming(initialize)).toMatchObject({ type: "initialize", memoryMiB: 1536 });
      const withoutMemory: Record<string, unknown> = { ...initialize };
      Reflect.deleteProperty(withoutMemory, "memoryMiB");
      expect(() => decodeControlIncoming(withoutMemory)).toThrow(VMError);
      for (const memoryMiB of [15, 3073, 1.5]) {
        expect(() => decodeControlIncoming({ ...initialize, memoryMiB })).toThrow(VMError);
      }
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});
