import { expect, it } from "vitest";
import { LinuxError, Reader } from "../../js-process/codec.js";
import { createNativeTty } from "./tty.js";
it("queries Linux termios for descriptor identity and keeps transport failures distinct", () => {
  const descriptors: bigint[] = [];
  const tty = createNativeTty({ sync(operation) {
    expect(operation.number).toBe(16); const request = new Reader(operation.payload);
    const fd = request.u64(); descriptors.push(fd); expect(request.u32()).toBe(0x5401); expect(request.blob().length).toBe(0); request.end();
    if (fd === 7n) throw new LinuxError(25);
    if (fd === 8n) throw new Error("Transport failed");
    return operation.decode({ value: 0n, bytes: new Uint8Array(36) });
  } });
  expect(tty.isatty(0)).toBe(true); expect(tty.isatty(7)).toBe(false);
  expect(tty.isatty(-1)).toBe(false); expect(tty.isatty("0")).toBe(false);
  expect(() => tty.isatty(8)).toThrow("Transport failed"); expect(descriptors).toEqual([0n, 7n, 8n]);
});
