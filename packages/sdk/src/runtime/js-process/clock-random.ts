import type { ClockHost, LinuxClock, RandomHost } from "../../js-process-types.js";
import { VMError } from "../errors.js";
import { type LinuxOperation, type LinuxResult, operation, protocol, viewBytes, Writer, writeBytes } from "./codec.js";
import type { LinuxClient } from "./transport.js";

const BigInt = globalThis.BigInt;

/** CLOCK_REALTIME (0) and CLOCK_MONOTONIC (1), the only clocks the wire admits. */
const CLOCK_IDS: Readonly<Record<LinuxClock, number>> = { realtime: 0, monotonic: 1 };
function clockId(clock: LinuxClock): number {
  const id: unknown = Object.hasOwn(CLOCK_IDS, clock) ? CLOCK_IDS[clock] : undefined;
  if (typeof id !== "number") throw new VMError("INVALID_ARGUMENT", "A clock is \"realtime\" or \"monotonic\"");
  return id;
}
function nanoseconds(result: LinuxResult): bigint {
  if (result.bytes.byteLength !== 0) protocol("Invalid Linux clock result");
  return result.value;
}
/** The most bytes one getrandom request carries. */
export const RANDOM_CHUNK_BYTES = 65_536;

export const clockOperations = {
  /** OXJR 228 clock_gettime: the VM's clock in nanoseconds (virtual guest time, as native programs read it). */
  now: (clock: LinuxClock): LinuxOperation<bigint> => operation(228, new Writer().u32(clockId(clock)), nanoseconds),
  /** OXJR 229 clock_getres; a resolution is never zero. */
  resolution: (clock: LinuxClock): LinuxOperation<bigint> => operation(229, new Writer().u32(clockId(clock)), result => {
    const resolution = nanoseconds(result);
    if (resolution === 0n) protocol("Invalid Linux clock resolution");
    return resolution;
  }),
};

/** OXJR 318 getrandom(count, 0): exactly `count` bytes (0 to 65,536) from the VM's entropy owner. */
export function randomOperation(count: number): LinuxOperation<Uint8Array> {
  if (!Number.isSafeInteger(count) || count < 0 || count > RANDOM_CHUNK_BYTES) throw new VMError("INVALID_ARGUMENT", "getrandom takes 0 to 65536 bytes");
  return operation(318, new Writer().u32(count).u32(0), result => {
    if (result.bytes.byteLength !== count || result.value !== BigInt(count)) protocol("Invalid Linux getrandom result");
    return result.bytes;
  });
}

export function clockHost(client: Pick<LinuxClient, "sync">): ClockHost {
  return Object.freeze({
    now: (clock: LinuxClock) => client.sync(clockOperations.now(clock)),
    resolution: (clock: LinuxClock) => client.sync(clockOperations.resolution(clock)),
  });
}

export function randomHost(client: Pick<LinuxClient, "sync">): RandomHost {
  return Object.freeze({
    fill: (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array)) throw new VMError("INVALID_ARGUMENT", "random.fill takes a Uint8Array");
      for (let offset = 0; offset < bytes.byteLength; offset += RANDOM_CHUNK_BYTES) {
        const count = Math.min(RANDOM_CHUNK_BYTES, bytes.byteLength - offset);
        writeBytes(viewBytes(bytes, offset, offset + count), client.sync(randomOperation(count)));
      }
    },
  });
}
