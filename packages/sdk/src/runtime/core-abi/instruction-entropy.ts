import { instructionIdentities } from "../isa-identities.generated.ts";
import { type BinaryCursor, fault } from "./cursor.ts";
import { recordPayload } from "./binary.ts";

export interface CoreEntropyRecord {
  readonly sequence: bigint;
  readonly instructionRip: bigint;
  readonly addressSpace: bigint;
  readonly word: bigint | null;
  readonly formCode: number;
  readonly semanticCode: number;
  readonly instructionId: "rdrand-register";
  readonly semanticId: "ReadRandomWord";
  readonly codeAttributes: number;
  readonly width: 16 | 32 | 64;
  readonly destination: number;
  readonly instructionLength: number;
  readonly mode: "real" | "protected" | "compatibility" | "long";
  readonly profile: "x86-64-v3";
  readonly capabilityRevision: 1;
  readonly cpl: 0 | 1 | 2 | 3;
}

export interface CoreEntropyCapture {
  readonly dropped: bigint;
  readonly records: readonly CoreEntropyRecord[];
}

export function decodeInstructionEntropy(bytes: Uint8Array): CoreEntropyCapture {
  const cursor = recordPayload(bytes, "OXEN", 1, bytes.byteLength - 12);
  const dropped = cursor.u64();
  const count = cursor.u32();
  cursor.zero(4, "entropy capture reserved field");
  if (count > 256 || bytes.byteLength !== 28 + count * 56) throw fault("invalid entropy capture bound");
  const records: CoreEntropyRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = decodeEntry(cursor);
    const prior = records.at(-1);
    if (prior !== undefined && record.sequence !== prior.sequence + 1n) throw fault("nonconsecutive entropy sequence");
    records.push(record);
  }
  cursor.finish("instruction entropy");
  return { dropped, records };
}

function decodeEntry(cursor: BinaryCursor): CoreEntropyRecord {
  const sequence = cursor.u64();
  const instructionRip = cursor.u64();
  const addressSpace = cursor.u64();
  const value = cursor.u64();
  const formCode = cursor.u16();
  const semanticCode = cursor.u16();
  const codeAttributes = cursor.u16();
  const width = decodeWidth(cursor.u8());
  const destination = cursor.u8();
  const instructionLength = cursor.u8();
  const mode = decodeMode(cursor.u8());
  const profile = cursor.u8();
  const capabilityRevision = cursor.u8();
  const cpl = decodePrivilege(cursor.u8());
  const kind = cursor.u8();
  cursor.zero(10, "entropy entry reserved fields");
  const authority = instructionIdentities["rdrand-register"];
  if (formCode !== authority.formCode || semanticCode !== authority.semanticCode
    || sequence === 0n || addressSpace === 0n || destination > 15
    || instructionLength < 3 || instructionLength > 15 || profile !== 2 || capabilityRevision !== 1
    || (mode !== "long" && (width === 64 || destination >= 8))
    || (width === 64 && instructionLength < 4)
    || kind > 1 || (kind === 0 && value !== 0n)) throw fault("invalid entropy replay context");
  return { sequence, instructionRip, addressSpace, word: kind === 0 ? null : value,
    formCode, semanticCode, instructionId: "rdrand-register", semanticId: authority.semanticId,
    codeAttributes, width, destination, instructionLength, mode, profile: "x86-64-v3",
    capabilityRevision: 1, cpl };
}

function decodeWidth(value: number): 16 | 32 | 64 {
  if (value === 16 || value === 32 || value === 64) return value;
  throw fault("invalid entropy operand width");
}

function decodeMode(value: number): CoreEntropyRecord["mode"] {
  switch (value) {
    case 0: return "real";
    case 1: return "protected";
    case 2: return "compatibility";
    case 3: return "long";
    default: throw fault("invalid entropy CPU mode");
  }
}

function decodePrivilege(value: number): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw fault("invalid entropy privilege level");
}
