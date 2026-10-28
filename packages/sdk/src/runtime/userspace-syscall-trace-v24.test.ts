import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function failedExec(number = 59n): Uint8Array {
  const bytes = new Uint8Array(24 + 752);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 24, true);
  view.setUint32(8, 752, true);
  view.setUint32(12, 1, true);
  for (const offset of [0, 8, 16]) view.setBigUint64(24 + offset, 1n, true);
  view.setUint32(24 + 24, 2, true);
  view.setUint32(24 + 28, 2, true);
  view.setBigUint64(24 + 32, 7n, true);
  view.setBigUint64(24 + 40, 0x401000n, true);
  view.setBigUint64(24 + 48, 0x401002n, true);
  view.setBigUint64(24 + 56, number, true);
  view.setUint8(24 + 120, 5);
  const name = new TextEncoder().encode(number === 59n ? "execve" : "execveat");
  view.setUint8(24 + 121, name.length);
  bytes.set(name, 24 + 152);
  view.setUint8(24 + 192, 5);
  view.setUint8(24 + 193, 11);
  view.setInt32(24 + 196, 12, true);
  view.setBigUint64(24 + 200, 8n, true);
  view.setBigUint64(24 + 208, 99n, true);
  return bytes;
}

describe("syscall trace v24 committed exec failures", () => {
  it.each([59n, 322n])("decodes %s without inventing a returned errno or successful exec", (number) => {
    expect(decodeUserspaceSyscallTrace(failedExec(number)).events[0]).toMatchObject({
      kind: "syscall", pid: 2, tid: 2, addressSpace: 7n, number,
      outcome: { kind: "exec-failure", stage: "address-space-limit", error: 12,
        signal: 11, replacementAddressSpace: 8n, guestTicks: 99n },
    });
  });

  it("retains every closed failure stage", () => {
    const stages = ["main-mapping", "interpreter-mapping", "stack-mapping", "initial-stack",
      "address-space-limit", "cpu-initialization", "close-descriptors", "command-launch", "io-cleanup"];
    for (const [index, stage] of stages.entries()) {
      const bytes = failedExec();
      bytes[24 + 192] = index + 1;
      expect(decodeUserspaceSyscallTrace(bytes).events[0]?.outcome).toMatchObject({ kind: "exec-failure", stage });
    }
  });

  it.each([0x7fff0000, 0x7ffc0000])("retains admitted filter action %s", (value) => {
    const bytes = failedExec();
    const view = new DataView(bytes.buffer);
    view.setUint8(24 + 272, 3);
    view.setUint32(24 + 276, value, true);
    view.setBigUint64(24 + 280, 1n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      seccomp: { kind: "filter", value }, outcome: { kind: "exec-failure" },
    });
  });

  it("rejects old meanings, forged identities, result payloads, waits and reserved fields", () => {
    const corruptions: readonly ((view: DataView) => void)[] = [
      (view) => view.setUint16(4, 23, true),
      (view) => view.setBigUint64(24 + 56, 426n, true),
      (view) => view.setBigInt64(24 + 112, -12n, true),
      (view) => view.setUint8(24 + 122, 5),
      (view) => view.setUint8(24 + 123, 1),
      (view) => view.setUint8(24 + 192, 0),
      (view) => view.setUint8(24 + 192, 10),
      (view) => view.setUint8(24 + 193, 9),
      (view) => view.setUint8(24 + 194, 1),
      (view) => view.setInt32(24 + 196, 0, true),
      (view) => view.setInt32(24 + 196, 5, true),
      (view) => view.setBigUint64(24 + 200, 0n, true),
      (view) => view.setBigUint64(24 + 200, 7n, true),
      (view) => view.setBigUint64(24 + 208, 0n, true),
      (view) => view.setUint8(24 + 216, 1),
      (view) => view.setUint8(24 + 264, 1),
      (view) => view.setUint8(24 + 272, 1),
      (view) => { view.setUint8(24 + 272, 3); view.setUint32(24 + 276, 0x50001, true); view.setBigUint64(24 + 280, 1n, true); },
    ];
    for (const corrupt of corruptions) {
      const bytes = failedExec();
      corrupt(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
