import { BinaryCursor, CoreAbiError, fault } from "./cursor.ts";

const RECORD_HEADER_LENGTH = 12;
const CPU_SNAPSHOT_VERSION = 7;
const CPU_PAYLOAD_LENGTH_V1 = 2868;
const CPU_PAYLOAD_LENGTH_V2 = 2872;
const CPU_PAYLOAD_LENGTH_V3 = 2896;
const CPU_PAYLOAD_LENGTH_V4 = 2904;
const CPU_PAYLOAD_LENGTH_V5 = 2912;
const CPU_PAYLOAD_LENGTH_V6 = 2968;
const CPU_PAYLOAD_LENGTH_V7 = 3008;
export const CPU_SNAPSHOT_BYTE_LENGTH = RECORD_HEADER_LENGTH + CPU_PAYLOAD_LENGTH_V7;

export function cpuPayload(bytes: Uint8Array): {
  readonly cursor: BinaryCursor;
  readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
} {
  const header = new BinaryCursor(bytes);
  for (const expected of [0x4f, 0x58, 0x43, 0x50]) {
    if (header.u8() !== expected) throw fault("CPU snapshot has invalid magic");
  }
  const rawVersion = header.u16();
  const version = decodeCpuSnapshotVersion(rawVersion);
  if (header.u16() !== 0) {
    throw fault("CPU snapshot has a nonzero reserved header");
  }
  const expectedPayloadLength =
    version === 1
      ? CPU_PAYLOAD_LENGTH_V1
      : version === 2
        ? CPU_PAYLOAD_LENGTH_V2
        : version === 3
          ? CPU_PAYLOAD_LENGTH_V3
          : version === 4 ? CPU_PAYLOAD_LENGTH_V4 : version === 5 ? CPU_PAYLOAD_LENGTH_V5
            : version === 6 ? CPU_PAYLOAD_LENGTH_V6 : CPU_PAYLOAD_LENGTH_V7;
  if (
    header.u32() !== expectedPayloadLength ||
    bytes.byteLength !== RECORD_HEADER_LENGTH + expectedPayloadLength
  ) {
    throw fault("CPU snapshot has an invalid length");
  }
  return { cursor: new BinaryCursor(bytes, RECORD_HEADER_LENGTH), version };
}

function decodeCpuSnapshotVersion(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6 || value === CPU_SNAPSHOT_VERSION) return value;
  throw new CoreAbiError(
    "SNAPSHOT_VERSION",
    `unsupported CPU snapshot version ${value}`,
  );
}
