import { VMError } from "../../errors.js";
import { LinuxError, operation, protocol, Writer } from "../../js-process/codec.js";
import type { LinuxClient } from "../../js-process/transport.js";

/** Descriptor classification comes from Rust's existing terminal ioctl owner. */
export function createNativeTty(client: Pick<LinuxClient, "sync">) {
  function isatty(fd: unknown): boolean {
    if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) return false;
    try {
      return client.sync(operation(16, new Writer().u64(fd).u32(0x5401).blob(new Uint8Array()), result => {
        if (result.value !== 0n || result.bytes.length !== 36) protocol("Invalid Linux termios reply"); return true;
      }));
    } catch (error) { if (error instanceof LinuxError) return false; throw error; }
  }
  const unavailable = (name: string) => function unsupportedTty(): never {
    throw new VMError("FEATURE_NOT_AVAILABLE", `tty.${name} is not qualified`);
  };
  return { isatty, ReadStream: unavailable("ReadStream"), WriteStream: unavailable("WriteStream") };
}
