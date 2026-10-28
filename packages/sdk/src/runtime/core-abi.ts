import type {
  CoreCpuState,
  CoreMode,
  SystemTraceCpu,
} from "./protocol.js";
import {
  type BinaryCursor,
  fault,
} from "./core-abi/cursor.ts";
import { cpuPayload } from "./core-abi/snapshot-layout.ts";
export { CPU_SNAPSHOT_BYTE_LENGTH } from "./core-abi/snapshot-layout.ts";
import { decodePaePdpte, type CorePaePdpte } from "./core-abi/paging-state.ts";
import { decodePerformanceState, type CorePerformanceState } from "./core-abi/performance-state.ts";
export type { CorePerformanceState } from "./core-abi/performance-state.ts";
import { pageEntry } from "./core-abi/binary.ts";
export { decodeRunResult } from "./core-abi/run-result.ts";
export type { CoreRunExit, CoreInternalFailure, CoreEntropyFailureReason } from "./core-abi/run-result.ts";

export {
  JIT_ADDRESS_SPACE_OFFSET,
  decodeJitRetiredInstructions,
  decodeJitModuleExit,
  isJitGuardExit,
  jitInterpretReason,
  JIT_API_VERSION,
  JIT_CONTEXT_LENGTH,
  JIT_DISPATCH_SLOT_GENERATIONS_OFFSET,
  JIT_CONTEXT_VERSION,
  JIT_EXIT_PERFORMANCE_BOUNDARY,
  JIT_EDGE_SAMPLE_DROPPED_OFFSET,
  JIT_EDGE_SAMPLE_PERIOD,
  JIT_EDGE_SAMPLE_TOTAL_OFFSET,
  JIT_OPERATION_SAMPLE_COUNT_OFFSET,
  JIT_OPERATION_SAMPLE_DROPPED_OFFSET,
  JIT_OPERATION_SAMPLE_ENTRIES,
  JIT_OPERATION_SAMPLE_ENTRY_LENGTH,
  JIT_OPERATION_SAMPLE_PERIOD,
  JIT_OPERATION_SAMPLES_OFFSET,
  JIT_OPERATION_SAMPLE_TOTAL_OFFSET,
  JIT_PROFILE_MODULE_IDS_OFFSET,
  JIT_TRACE_RECORD_COUNT_OFFSET,
  JIT_TRACE_RECORD_DROPPED_OFFSET,
  JIT_TRACE_RECORD_ENTRIES,
  JIT_TRACE_RECORD_ENTRY_LENGTH,
  JIT_TRACE_RECORD_TOTAL_OFFSET,
  JIT_TRACE_RECORDS_OFFSET,
} from "./core-abi/jit.ts";
export type { CoreJitInterpretReason, CoreJitModuleExit } from "./core-abi/jit.ts";
export { JIT_INTERPRET_REASONS, jitInterpretReasonName } from "./core-abi/jit.ts";
export { decodeCorePendingAot } from "./core-abi/aot.ts";
export type { CorePendingAot } from "./core-abi/aot.ts";
export { decodeAotIndex } from "./core-abi/aot-index.ts";
export type { AotIndexMember, AotIndexPack, AotIndexSpan, DecodedAotIndex } from "./core-abi/aot-index.ts";
export { CoreAbiError } from "./core-abi/cursor.ts";
export type { CoreAbiErrorCode } from "./core-abi/cursor.ts";
export const CORE_API_VERSION = 19;
export { SYSTEM_TRACE_SCHEMA_VERSION } from "./protocol/system-trace-schema.ts";
export { createCoreEntropyImport } from "./core-abi/entropy.ts";
export { decodeInstructionEntropy } from "./core-abi/instruction-entropy.ts";
export type { CoreEntropyCapture, CoreEntropyRecord } from "./core-abi/instruction-entropy.ts";

const RECORD_HEADER_LENGTH = 12;
const RFLAGS_MASK = 0x3f_7fd7n;
const EFER_MASK = 1n | (1n << 8n) | (1n << 10n) | (1n << 11n);
const XSTATE_MASK = (1n << 19n) - 1n;
const CR0_MASK = 0x3fn | (1n << 16n) | (1n << 18n) | (7n << 29n);
const CR0_PROTECTED_MODE_ENABLE = 1n;
const CR0_PAGING = 1n << 31n;
const CR4_VIRTUAL_8086_MODE_EXTENSIONS = 1n;
const CR4_PROTECTED_MODE_VIRTUAL_INTERRUPTS = 1n << 1n;
const CR4_TIMESTAMP_DISABLE = 1n << 2n;
const CR4_DEBUGGING_EXTENSIONS = 1n << 3n;
const CR4_PAGE_SIZE_EXTENSIONS = 1n << 4n;
const CR4_PHYSICAL_ADDRESS_EXTENSION = 1n << 5n;
const CR4_OSFXSR = 1n << 9n;
const CR4_PROCESS_CONTEXT_IDENTIFIERS = 1n << 17n;
const CR4_MASK =
  CR4_VIRTUAL_8086_MODE_EXTENSIONS |
  CR4_PROTECTED_MODE_VIRTUAL_INTERRUPTS |
  CR4_TIMESTAMP_DISABLE |
  CR4_DEBUGGING_EXTENSIONS |
  CR4_PAGE_SIZE_EXTENSIONS |
  CR4_PHYSICAL_ADDRESS_EXTENSION |
  (1n << 7n) |
  (1n << 8n) |
  CR4_OSFXSR |
  (1n << 10n) |
  (1n << 16n) |
  CR4_PROCESS_CONTEXT_IDENTIFIERS |
  (1n << 18n) |
  (1n << 20n) |
  (1n << 21n) |
  (1n << 22n) |
  (1n << 24n);
const CR3_ADDRESS_MASK = 0x000f_ffff_ffff_f000n;
const EFER_SYSTEM_CALL_EXTENSIONS = 1n;
const EFER_LONG_MODE_ENABLE = 1n << 8n;
const EFER_LONG_MODE_ACTIVE = 1n << 10n;
const SEGMENT_ATTRIBUTE_LONG = 1 << 13;
const SEGMENT_ATTRIBUTE_DEFAULT_SIZE = 1 << 14;

const RSP_OFFSET = RECORD_HEADER_LENGTH + 4 * 8;
const RIP_OFFSET = RECORD_HEADER_LENGTH + 16 * 8;
const RFLAGS_OFFSET = RIP_OFFSET + 8;
const HALTED_OFFSET = RIP_OFFSET + 16;
const MODE_OFFSET = HALTED_OFFSET + 1;
const CPL_OFFSET = MODE_OFFSET + 1;
const PROFILE_OFFSET = CPL_OFFSET + 1;
const CS_SELECTOR_OFFSET = RECORD_HEADER_LENGTH + 16 * 8 + 20;
const CS_BASE_OFFSET = RECORD_HEADER_LENGTH + 16 * 8 + 20 + 2;
const CS_ATTRIBUTES_OFFSET = RECORD_HEADER_LENGTH + 16 * 8 + 20 + 14;
const CR0_OFFSET = 408;
const CR3_OFFSET = 424;
const CR4_OFFSET = 432;
const DEBUG_OFFSET = 456;
const EFER_OFFSET = 520;
const SEGMENTS_OFFSET = 160;
const SEGMENT_LENGTH = 16;
const GDTR_OFFSET = 288;
const IDTR_OFFSET = 304;
const TSS_OFFSET = 320;
const X87_OFFSET = 592;
const ZMM_OFFSET = 744;
const MXCSR_OFFSET = 2856;
const XCR0_OFFSET = 2864;
const XSS_OFFSET = 2872;
const EVENTS_OFFSET = 2880;
const SYSENTER_OFFSET = 2884;

const DIAGNOSTIC_STACK = 0x1f_f000n;
const DIAGNOSTIC_PML4 = 0x20_0000n;
const DIAGNOSTIC_PDPT = 0x20_1000n;
const DIAGNOSTIC_PD = 0x20_2000n;

export type CoreProfile = "baseline" | "x86-64-v2" | "x86-64-v3";
export type CoreInterruptShadow = "none" | "sti" | "mov-ss";

export interface CoreSegmentState {
  readonly selector: number;
  readonly base: bigint;
  readonly limit: number;
  readonly attributes: number;
}

export interface CoreDescriptorTable {
  readonly base: bigint;
  readonly limit: number;
}

export interface CoreTaskState {
  readonly rsp: readonly bigint[];
  readonly ist: readonly bigint[];
  readonly ioBitmapBase: number;
}

export interface CoreControlState {
  readonly cr0: bigint;
  readonly cr2: bigint;
  readonly cr3: bigint;
  readonly cr4: bigint;
  readonly cr8: bigint;
}

export interface CoreMsrState {
  readonly efer: bigint;
  readonly star: bigint;
  readonly lstar: bigint;
  readonly cstar: bigint;
  readonly sfmask: bigint;
  readonly fsBase: bigint;
  readonly gsBase: bigint;
  readonly kernelGsBase: bigint;
  readonly tscAux: bigint;
  readonly sysenterCs: bigint;
  readonly sysenterEsp: bigint;
  readonly sysenterEip: bigint;
}

export interface CoreX87State {
  readonly registers: readonly bigint[];
  readonly control: number;
  readonly status: number;
  readonly tag: number;
  readonly opcode: number;
  readonly instructionPointer: bigint;
  readonly instructionSelector: number;
  readonly dataPointer: bigint;
  readonly dataSelector: number;
}

export interface CoreVectorState {
  readonly x87: CoreX87State;
  readonly zmm: readonly (readonly bigint[])[];
  readonly opmask: readonly bigint[];
  readonly mxcsr: number;
  readonly xcr0: bigint;
  readonly xss: bigint;
  readonly xstateInUse: bigint;
}

export interface DecodedCpuSnapshot {
  readonly capabilityRevision: 0 | 1;
  readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly state: CoreCpuState;
  readonly halted: boolean;
  readonly profile: CoreProfile;
  readonly segments: {
    readonly cs: CoreSegmentState;
    readonly ss: CoreSegmentState;
    readonly ds: CoreSegmentState;
    readonly es: CoreSegmentState;
    readonly fs: CoreSegmentState;
    readonly gs: CoreSegmentState;
    readonly ldtr: CoreSegmentState;
    readonly tr: CoreSegmentState;
  };
  readonly gdtr: CoreDescriptorTable;
  readonly idtr: CoreDescriptorTable;
  readonly tss: CoreTaskState;
  readonly control: CoreControlState;
  readonly paePdpte: CorePaePdpte;
  readonly protectionKeys: {
    readonly pkru: number;
    readonly pkrs: number;
  };
  readonly debug: readonly bigint[];
  readonly msrs: CoreMsrState;
  readonly vector: CoreVectorState;
  readonly performance: CorePerformanceState;
  readonly events: {
    readonly interruptShadow: CoreInterruptShadow;
    readonly nmiBlocked: boolean;
    readonly deliveryDepth: number;
  };
}

export function unsignedWasmPointer(pointer: number): number {
  return pointer < 0 ? pointer + 0x1_0000_0000 : pointer;
}

export interface CoreSnapshotFieldGroups {
  readonly registers: Readonly<Record<string, bigint>>;
  readonly segments: Readonly<Record<string, bigint>>;
  readonly tables: Readonly<Record<string, bigint>>;
  readonly tss: Readonly<Record<string, bigint>>;
  readonly control: Readonly<Record<string, bigint>>;
  readonly vector: Readonly<Record<string, bigint>>;
  readonly events: Readonly<Record<string, bigint>>;
}

export interface DiagnosticMemoryRegion {
  readonly address: bigint;
  readonly bytes: Uint8Array;
}

export interface DiagnosticCpuFixture {
  readonly cpuState: Uint8Array;
  readonly programAddress: bigint;
  readonly memory: readonly DiagnosticMemoryRegion[];
}

export interface DiagnosticCpuPatch {
  readonly profile?: CoreProfile;
  readonly registers: Readonly<Record<string, bigint>>;
  readonly rip: bigint;
  readonly rflags: bigint;
  readonly cpl: number;
  readonly segments: Readonly<Record<string, bigint>>;
  readonly tables: Readonly<Record<string, bigint>>;
  readonly tss: Readonly<Record<string, bigint>>;
  readonly control: Readonly<Record<string, bigint>>;
  readonly vector: Readonly<Record<string, bigint>>;
  readonly events: Readonly<Record<string, bigint>>;
}

export type DiagnosticLongModeFixture = DiagnosticCpuFixture;

export { decodeJitAction } from "./core-abi/jit.ts";
export { decodeJitAliasEvents } from "./core-abi/jit-aliases.ts";
export type { CoreJitAction } from "./core-abi/jit.ts";

export function decodeCpuSnapshot(bytes: Uint8Array, owner: "system" | "userspace" = "system"): DecodedCpuSnapshot {
  const { cursor, version } = cpuPayload(bytes);
  const registers = {
    rax: cursor.u64(),
    rcx: cursor.u64(),
    rdx: cursor.u64(),
    rbx: cursor.u64(),
    rsp: cursor.u64(),
    rbp: cursor.u64(),
    rsi: cursor.u64(),
    rdi: cursor.u64(),
    r8: cursor.u64(),
    r9: cursor.u64(),
    r10: cursor.u64(),
    r11: cursor.u64(),
    r12: cursor.u64(),
    r13: cursor.u64(),
    r14: cursor.u64(),
    r15: cursor.u64(),
  };
  const rip = cursor.u64();
  const rflags = cursor.u64();
  validateRflags(rflags);
  const halted = decodeBoolean(cursor.u8(), "halted");
  const mode = decodeMode(cursor.u8());
  const cpl = decodeCpl(cursor.u8());
  const profile = decodeProfile(cursor.u8());
  const state: CoreCpuState = {
    ...registers,
    rip,
    rflags,
    mode,
    cpl,
  };
  const segments = {
    cs: decodeSegment(cursor),
    ss: decodeSegment(cursor),
    ds: decodeSegment(cursor),
    es: decodeSegment(cursor),
    fs: decodeSegment(cursor),
    gs: decodeSegment(cursor),
    ldtr: decodeSegment(cursor),
    tr: decodeSegment(cursor),
  };
  const gdtr = decodeDescriptorTable(cursor);
  const idtr = decodeDescriptorTable(cursor);
  const tss = {
    rsp: readMany(3, () => canonical(cursor.u64(), "TSS RSP")),
    ist: readMany(7, () => canonical(cursor.u64(), "TSS IST")),
    ioBitmapBase: cursor.u16(),
  };
  cursor.zero(6, "TSS reserved field");
  const control = {
    cr0: cursor.u64(),
    cr2: cursor.u64(),
    cr3: cursor.u64(),
    cr4: cursor.u64(),
    cr8: cursor.u64(),
  };
  validateControl(control, mode);
  const protectionKeys = {
    pkru: cursor.u32(),
    pkrs: cursor.u32(),
  };
  const debug = readMany(8, () => cursor.u64());
  const msrs = {
    efer: cursor.u64(),
    star: cursor.u64(),
    lstar: cursor.u64(),
    cstar: cursor.u64(),
    sfmask: cursor.u64(),
    fsBase: cursor.u64(),
    gsBase: cursor.u64(),
    kernelGsBase: cursor.u64(),
    tscAux: cursor.u64(),
  };
  if ((msrs.efer & ~EFER_MASK) !== 0n) {
    throw fault("CPU snapshot has invalid EFER");
  }
  canonical(msrs.fsBase, "FS base");
  canonical(msrs.gsBase, "GS base");
  canonical(msrs.kernelGsBase, "KERNEL_GS base");
  if (msrs.tscAux > 0xffff_ffffn) {
    throw fault("CPU snapshot has invalid TSC_AUX");
  }
  const x87Registers = readMany(8, () => {
    const low = cursor.u64();
    const high = cursor.u64();
    if (high > 0xffffn) {
      throw fault("CPU snapshot has invalid x87 register");
    }
    return low | (high << 64n);
  });
  const x87Base = {
    registers: x87Registers,
    control: cursor.u16(),
    status: cursor.u16(),
    tag: cursor.u16(),
    opcode: cursor.u16(),
    instructionPointer: cursor.u64(),
    dataPointer: cursor.u64(),
  };
  const zmm = readMany(32, () => readMany(8, () => cursor.u64()));
  const opmask = readMany(8, () => cursor.u64());
  const mxcsr = cursor.u32();
  if ((mxcsr & ~0xffff) !== 0) {
    throw fault("CPU snapshot has invalid MXCSR");
  }
  const x87 =
    version >= 2
      ? {
          ...x87Base,
          instructionSelector: cursor.u16(),
          dataSelector: cursor.u16(),
        }
      : {
          ...x87Base,
          instructionSelector: 0,
          dataSelector: 0,
        };
  if (version < 2) {
    cursor.zero(4, "vector reserved field");
  }
  const xcr0 = cursor.u64();
  const xss = cursor.u64();
  validateXstate(xcr0, xss);
  const events =
    version >= 2
      ? {
          interruptShadow: decodeInterruptShadow(cursor.u8()),
          nmiBlocked: decodeBoolean(cursor.u8(), "NMI blocked"),
          deliveryDepth: cursor.u8(),
        }
      : {
          interruptShadow: "none" as const,
          nmiBlocked: false,
          deliveryDepth: 0,
        };
  if (version >= 2) {
    cursor.zero(1, "event reserved field");
  }
  const sysenter =
    version >= 3
      ? {
          sysenterCs: cursor.u64(),
          sysenterEsp: cursor.u64(),
          sysenterEip: cursor.u64(),
        }
      : { sysenterCs: 0n, sysenterEsp: 0n, sysenterEip: 0n };
  if (sysenter.sysenterCs > 0xffffn) {
    throw fault("CPU snapshot has invalid SYSENTER_CS");
  }
  const capabilityRevision = version >= 4 ? cursor.u8() : 0;
  if (capabilityRevision !== 0 && capabilityRevision !== 1) {
    throw fault("CPU snapshot has invalid capability revision");
  }
  if (version >= 4) cursor.zero(7, "capability reserved field");
  const xstateInUse = version >= 5 ? cursor.u64() : 0n;
  if ((xstateInUse & ~7n) !== 0n) throw fault("CPU snapshot has invalid XINUSE");
  const performance = decodePerformanceState(cursor, version, profile === "x86-64-v3" && capabilityRevision === 1);
  const paePdpte = decodePaePdpte(cursor, version);
  if (version >= 7 && paePdpte === null && (control.cr0 & CR0_PAGING) !== 0n
    && (control.cr4 & CR4_PHYSICAL_ADDRESS_EXTENSION) !== 0n && (msrs.efer & EFER_LONG_MODE_ENABLE) === 0n) {
    throw fault("CPU snapshot has missing PAE PDPTE state");
  }
  cursor.finish("CPU snapshot");
  validateMode(state.mode, segments.cs.attributes, control, msrs.efer, owner === "userspace" && state.cpl === 3 && profile !== "baseline");

  return {
    version,
    capabilityRevision,
    state,
    halted,
    profile,
    segments,
    gdtr,
    idtr,
    tss,
    control,
    paePdpte,
    protectionKeys,
    debug,
    msrs: { ...msrs, ...sysenter },
    vector: { x87, zmm, opmask, mxcsr, xcr0, xss, xstateInUse },
    performance,
    events,
  };
}

export function decodeCpuTraceState(bytes: Uint8Array): SystemTraceCpu {
  cpuPayload(bytes);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const readRegister = (index: number) =>
    view.getBigUint64(RECORD_HEADER_LENGTH + index * 8, true);
  const rflags = view.getBigUint64(RFLAGS_OFFSET, true);
  validateRflags(rflags);
  const mode = decodeMode(view.getUint8(MODE_OFFSET));
  const cpl = decodeCpl(view.getUint8(CPL_OFFSET));
  const control = {
    cr0: view.getBigUint64(CR0_OFFSET, true),
    cr2: view.getBigUint64(CR0_OFFSET + 8, true),
    cr3: view.getBigUint64(CR3_OFFSET, true),
    cr4: view.getBigUint64(CR4_OFFSET, true),
    cr8: view.getBigUint64(CR4_OFFSET + 8, true),
  };
  validateControl(control, mode);
  validateMode(
    mode,
    view.getUint16(CS_ATTRIBUTES_OFFSET, true),
    control,
    view.getBigUint64(EFER_OFFSET, true),
  );
  return {
    rip: view.getBigUint64(RIP_OFFSET, true),
    rflags,
    cr3: control.cr3,
    cpl,
    mode,
    registers: {
      rax: readRegister(0),
      rcx: readRegister(1),
      rdx: readRegister(2),
      rbx: readRegister(3),
      rsp: readRegister(4),
      rbp: readRegister(5),
      rsi: readRegister(6),
      rdi: readRegister(7),
      r8: readRegister(8),
      r9: readRegister(9),
      r10: readRegister(10),
      r11: readRegister(11),
      r12: readRegister(12),
      r13: readRegister(13),
      r14: readRegister(14),
      r15: readRegister(15),
    },
  };
}

export function cpuSnapshotFieldGroups(
  snapshot: DecodedCpuSnapshot,
): CoreSnapshotFieldGroups {
  const segments: Record<string, bigint> = {};
  for (const [name, segment] of Object.entries(snapshot.segments)) {
    segments[`${name}Selector`] = BigInt(segment.selector);
    segments[`${name}Base`] = segment.base;
    segments[`${name}Limit`] = BigInt(segment.limit);
    segments[`${name}Attributes`] = BigInt(segment.attributes);
  }
  const vector: Record<string, bigint> = {
    x87Control: BigInt(snapshot.vector.x87.control),
    x87Status: BigInt(snapshot.vector.x87.status),
    x87Tag: BigInt(snapshot.vector.x87.tag),
    x87Opcode: BigInt(snapshot.vector.x87.opcode),
    x87InstructionPointer: snapshot.vector.x87.instructionPointer,
    x87InstructionSelector: BigInt(snapshot.vector.x87.instructionSelector),
    x87DataPointer: snapshot.vector.x87.dataPointer,
    x87DataSelector: BigInt(snapshot.vector.x87.dataSelector),
    mxcsr: BigInt(snapshot.vector.mxcsr),
    xcr0: snapshot.vector.xcr0,
    xss: snapshot.vector.xss,
    xstateInUse: snapshot.vector.xstateInUse,
  };
  snapshot.vector.x87.registers.forEach((value, index) => {
    vector[`st${index}`] = value;
  });
  snapshot.vector.zmm.slice(0, 16).forEach((value, index) => {
    vector[`xmm${index}`] = (value[0] ?? 0n) | ((value[1] ?? 0n) << 64n);
    vector[`ymm${index}High`] =
      (value[2] ?? 0n) | ((value[3] ?? 0n) << 64n);
  });
  return {
    registers: {
      rax: snapshot.state.rax,
      rcx: snapshot.state.rcx,
      rdx: snapshot.state.rdx,
      rbx: snapshot.state.rbx,
      rsp: snapshot.state.rsp,
      rbp: snapshot.state.rbp,
      rsi: snapshot.state.rsi,
      rdi: snapshot.state.rdi,
      r8: snapshot.state.r8,
      r9: snapshot.state.r9,
      r10: snapshot.state.r10,
      r11: snapshot.state.r11,
      r12: snapshot.state.r12,
      r13: snapshot.state.r13,
      r14: snapshot.state.r14,
      r15: snapshot.state.r15,
    },
    segments,
    tables: {
      gdtrBase: snapshot.gdtr.base,
      gdtrLimit: BigInt(snapshot.gdtr.limit),
      idtrBase: snapshot.idtr.base,
      idtrLimit: BigInt(snapshot.idtr.limit),
    },
    tss: {
      rsp0: snapshot.tss.rsp[0] ?? 0n,
      rsp1: snapshot.tss.rsp[1] ?? 0n,
      rsp2: snapshot.tss.rsp[2] ?? 0n,
      ist1: snapshot.tss.ist[0] ?? 0n,
      ist2: snapshot.tss.ist[1] ?? 0n,
      ist3: snapshot.tss.ist[2] ?? 0n,
      ist4: snapshot.tss.ist[3] ?? 0n,
      ist5: snapshot.tss.ist[4] ?? 0n,
      ist6: snapshot.tss.ist[5] ?? 0n,
      ist7: snapshot.tss.ist[6] ?? 0n,
      ioBitmapBase: BigInt(snapshot.tss.ioBitmapBase),
    },
    control: {
      cr0: snapshot.control.cr0,
      cr2: snapshot.control.cr2,
      cr3: snapshot.control.cr3,
      cr4: snapshot.control.cr4,
      cr8: snapshot.control.cr8,
      dr0: snapshot.debug[0] ?? 0n,
      dr1: snapshot.debug[1] ?? 0n,
      dr2: snapshot.debug[2] ?? 0n,
      dr3: snapshot.debug[3] ?? 0n,
      dr4: snapshot.debug[4] ?? 0n,
      dr5: snapshot.debug[5] ?? 0n,
      dr6: snapshot.debug[6] ?? 0n,
      dr7: snapshot.debug[7] ?? 0n,
      efer: snapshot.msrs.efer,
      star: snapshot.msrs.star,
      lstar: snapshot.msrs.lstar,
      cstar: snapshot.msrs.cstar,
      sfmask: snapshot.msrs.sfmask,
      fsBase: snapshot.msrs.fsBase,
      gsBase: snapshot.msrs.gsBase,
      kernelGsBase: snapshot.msrs.kernelGsBase,
      tscAux: snapshot.msrs.tscAux,
      sysenterCs: snapshot.msrs.sysenterCs,
      sysenterEsp: snapshot.msrs.sysenterEsp,
      sysenterEip: snapshot.msrs.sysenterEip,
      fixedCounter0: snapshot.performance.fixedCounter0,
      fixedCounterControl: snapshot.performance.fixedCounterControl,
      perfGlobalControl: snapshot.performance.perfGlobalControl,
      perfGlobalStatus: snapshot.performance.perfGlobalStatus,
      perfOverflowControl: snapshot.performance.perfOverflowControl,
      debugControl: snapshot.performance.debugControl,
      pmiPending: BigInt(snapshot.performance.pmiPending),
      paePdpteLoaded: snapshot.paePdpte === null ? 0n : 1n,
      paePdpte0: snapshot.paePdpte?.[0] ?? 0n,
      paePdpte1: snapshot.paePdpte?.[1] ?? 0n,
      paePdpte2: snapshot.paePdpte?.[2] ?? 0n,
      paePdpte3: snapshot.paePdpte?.[3] ?? 0n,
    },
    vector,
    events: {
      interruptShadow: BigInt(
        snapshot.events.interruptShadow === "none"
          ? 0
          : snapshot.events.interruptShadow === "sti"
            ? 1
            : 2,
      ),
      nmiBlocked: snapshot.events.nmiBlocked ? 1n : 0n,
      deliveryDepth: BigInt(snapshot.events.deliveryDepth),
    },
  };
}

export function createDiagnosticLongModeFixture(
  resetState: Uint8Array,
): DiagnosticLongModeFixture {
  return createDiagnosticCpuFixture(resetState, "long");
}

export function createDiagnosticCpuFixture(
  resetState: Uint8Array,
  mode: CoreMode,
  profile: CoreProfile = "baseline",
): DiagnosticCpuFixture {
  decodeCpuSnapshot(resetState);
  const cpuState = resetState.slice();
  const view = new DataView(
    cpuState.buffer,
    cpuState.byteOffset,
    cpuState.byteLength,
  );
  view.setBigUint64(RSP_OFFSET, DIAGNOSTIC_STACK, true);
  view.setBigUint64(RIP_OFFSET, 0n, true);
  view.setUint8(HALTED_OFFSET, 0);
  view.setUint8(MODE_OFFSET, encodeMode(mode));
  view.setUint8(PROFILE_OFFSET, encodeProfile(profile));
  view.setUint16(CS_SELECTOR_OFFSET, 0, true);
  view.setBigUint64(CS_BASE_OFFSET, 0n, true);
  const protectedMode = mode !== "real";
  const longActive = mode === "compatibility" || mode === "long";
  const longCode = mode === "long";
  view.setUint16(
    CS_ATTRIBUTES_OFFSET,
    (view.getUint16(CS_ATTRIBUTES_OFFSET, true) &
      ~(SEGMENT_ATTRIBUTE_LONG | SEGMENT_ATTRIBUTE_DEFAULT_SIZE)) |
      (longCode ? SEGMENT_ATTRIBUTE_LONG : 0) |
      (mode === "protected" || mode === "compatibility"
        ? SEGMENT_ATTRIBUTE_DEFAULT_SIZE
        : 0),
    true,
  );
  view.setBigUint64(
    CR0_OFFSET,
    (view.getBigUint64(CR0_OFFSET, true) &
      ~(CR0_PROTECTED_MODE_ENABLE | CR0_PAGING)) |
      (protectedMode ? CR0_PROTECTED_MODE_ENABLE : 0n) |
      (longActive ? CR0_PAGING : 0n),
    true,
  );
  view.setBigUint64(CR3_OFFSET, longActive ? DIAGNOSTIC_PML4 : 0n, true);
  view.setBigUint64(
    CR4_OFFSET,
    (view.getBigUint64(CR4_OFFSET, true) &
      ~CR4_PHYSICAL_ADDRESS_EXTENSION) |
      (longActive ? CR4_PHYSICAL_ADDRESS_EXTENSION : 0n) |
      CR4_OSFXSR,
    true,
  );
  view.setBigUint64(
    EFER_OFFSET,
    (view.getBigUint64(EFER_OFFSET, true) &
      ~(
        EFER_SYSTEM_CALL_EXTENSIONS |
        EFER_LONG_MODE_ENABLE |
        EFER_LONG_MODE_ACTIVE
      )) |
      EFER_SYSTEM_CALL_EXTENSIONS |
      (longActive ? EFER_LONG_MODE_ENABLE | EFER_LONG_MODE_ACTIVE : 0n),
    true,
  );
  decodeCpuSnapshot(cpuState);

  return {
    cpuState,
    programAddress: 0n,
    memory: longActive
      ? [
          {
            address: DIAGNOSTIC_PML4,
            bytes: pageEntry(DIAGNOSTIC_PDPT | 3n),
          },
          {
            address: DIAGNOSTIC_PDPT,
            bytes: pageEntry(DIAGNOSTIC_PD | 3n),
          },
          { address: DIAGNOSTIC_PD, bytes: pageEntry(0x83n) },
        ]
      : [],
  };
}

export function patchDiagnosticCpuFixture(
  fixture: DiagnosticCpuFixture,
  patch: DiagnosticCpuPatch,
): DiagnosticCpuFixture {
  const cpuState = fixture.cpuState.slice();
  const view = new DataView(
    cpuState.buffer,
    cpuState.byteOffset,
    cpuState.byteLength,
  );
  for (const [register, value] of Object.entries(patch.registers)) {
    view.setBigUint64(registerOffset(register), u64(value, register), true);
  }
  view.setBigUint64(RIP_OFFSET, u64(patch.rip, "RIP"), true);
  view.setBigUint64(RFLAGS_OFFSET, u64(patch.rflags, "RFLAGS"), true);
  if (!Number.isInteger(patch.cpl) || patch.cpl < 0 || patch.cpl > 3) {
    throw fault("CPU patch has invalid CPL");
  }
  view.setUint8(CPL_OFFSET, patch.cpl);
  if (patch.profile !== undefined) {
    view.setUint8(PROFILE_OFFSET, encodeProfile(patch.profile));
  }
  patchFields(view, patch.segments, segmentPatchField, "segment");
  patchFields(view, patch.tables, tablePatchField, "table");
  patchFields(view, patch.tss, tssPatchField, "TSS");
  patchFields(view, patch.control, controlPatchField, "control");
  patchFields(view, patch.vector, vectorPatchField, "vector");
  patchFields(view, patch.events, eventPatchField, "event");
  decodeCpuSnapshot(cpuState);
  return {
    ...fixture,
    cpuState,
    programAddress: patch.rip,
    memory:
      patch.cpl === 0
        ? fixture.memory
        : fixture.memory.map((region) => ({
            ...region,
            bytes: userPageEntry(region.bytes),
          })),
  };
}



function decodeSegment(cursor: BinaryCursor): CoreSegmentState {
  return {
    selector: cursor.u16(),
    base: cursor.u64(),
    limit: cursor.u32(),
    attributes: cursor.u16(),
  };
}

function decodeDescriptorTable(cursor: BinaryCursor): CoreDescriptorTable {
  const table = { base: cursor.u64(), limit: cursor.u16() };
  cursor.zero(6, "descriptor-table reserved field");
  return table;
}

function validateRflags(rflags: bigint): void {
  if ((rflags & 2n) === 0n || (rflags & ~RFLAGS_MASK) !== 0n) {
    throw fault("CPU snapshot has invalid RFLAGS");
  }
}

function validateControl(control: CoreControlState, mode: CoreMode): void {
  if ((control.cr0 & ~CR0_MASK) !== 0n || (control.cr0 & (1n << 4n)) === 0n
    || (control.cr0 & (1n << 29n)) !== 0n && (control.cr0 & (1n << 30n)) === 0n) {
    throw fault("CPU snapshot has invalid CR0");
  }
  if ((mode === "long" || mode === "compatibility" || (control.cr4 & CR4_PROCESS_CONTEXT_IDENTIFIERS) !== 0n)
    && (control.cr3 & ~(CR3_ADDRESS_MASK | 0xfffn)) !== 0n) {
    throw fault("CPU snapshot has invalid CR3");
  }
  if ((control.cr4 & ~CR4_MASK) !== 0n) {
    throw fault("CPU snapshot has invalid CR4");
  }
  if (control.cr8 > 15n) {
    throw fault("CPU snapshot has invalid CR8");
  }
}

function validateXstate(xcr0: bigint, xss: bigint): void {
  if (
    (xcr0 & ~XSTATE_MASK) !== 0n ||
    (xss & ~XSTATE_MASK) !== 0n ||
    (xcr0 & 1n) === 0n ||
    ((xcr0 & 4n) !== 0n && (xcr0 & 2n) === 0n)
  ) {
    throw fault("CPU snapshot has invalid XSAVE controls");
  }
}

function validateMode(
  mode: CoreMode,
  csAttributes: number,
  control: CoreControlState,
  efer: bigint,
  managedUser = false,
): void {
  const protectedMode = (control.cr0 & CR0_PROTECTED_MODE_ENABLE) !== 0n;
  const paging = (control.cr0 & CR0_PAGING) !== 0n;
  const longEnabled = (efer & EFER_LONG_MODE_ENABLE) !== 0n;
  if (paging && !protectedMode) {
    throw fault("CPU snapshot enables paging outside protected mode");
  }
  if (
    paging &&
    longEnabled &&
    (control.cr4 & CR4_PHYSICAL_ADDRESS_EXTENSION) === 0n
  ) {
    throw fault("CPU snapshot enables long mode without PAE");
  }
  if (managedUser && mode === "long" && protectedMode && longEnabled && !paging && (csAttributes & SEGMENT_ATTRIBUTE_LONG) !== 0) return;
  const longActive = paging && longEnabled;
  if (((efer & EFER_LONG_MODE_ACTIVE) !== 0n) !== longActive) {
    throw fault("CPU snapshot has inconsistent EFER.LMA");
  }
  const expectedMode: CoreMode = longActive
    ? (csAttributes & SEGMENT_ATTRIBUTE_LONG) === 0
      ? "compatibility"
      : "long"
    : protectedMode
      ? "protected"
      : "real";
  if (mode !== expectedMode) {
    throw fault("CPU snapshot has an inconsistent execution mode");
  }
}

function canonical(value: bigint, field: string): bigint {
  const signExtension = value >> 47n;
  if (
    value !== 0n &&
    signExtension !== 0n &&
    signExtension !== 0x1_ffffn
  ) {
    throw fault(`CPU snapshot has invalid ${field}`);
  }
  return value;
}

function decodeMode(value: number): CoreMode {
  switch (value) {
    case 0:
      return "real";
    case 1:
      return "protected";
    case 2:
      return "compatibility";
    case 3:
      return "long";
    default:
      throw fault(`unknown CPU mode ${value}`);
  }
}

function encodeMode(mode: CoreMode): number {
  switch (mode) {
    case "real":
      return 0;
    case "protected":
      return 1;
    case "compatibility":
      return 2;
    case "long":
      return 3;
  }
}

function registerOffset(register: string): number {
  const index = [
    "rax",
    "rcx",
    "rdx",
    "rbx",
    "rsp",
    "rbp",
    "rsi",
    "rdi",
    "r8",
    "r9",
    "r10",
    "r11",
    "r12",
    "r13",
    "r14",
    "r15",
  ].indexOf(register);
  if (index < 0) throw fault(`CPU patch has unknown register ${register}`);
  return RECORD_HEADER_LENGTH + index * 8;
}

function u64(value: bigint, field: string): bigint {
  if (value < 0n || value >= 1n << 64n) {
    throw fault(`CPU patch has invalid ${field}`);
  }
  return value;
}

type PatchWidth = 8 | 16 | 32 | 64 | 80 | 128;

interface PatchField {
  readonly offset: number;
  readonly width: PatchWidth;
}

type PatchFieldResolver = (name: string) => PatchField | undefined;

function patchFields(
  view: DataView,
  fields: Readonly<Record<string, bigint>>,
  resolveField: PatchFieldResolver,
  group: string,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const field = resolveField(name);
    if (field === undefined) {
      throw fault(`CPU patch has unknown ${group} field ${name}`);
    }
    if (field.offset + field.width / 8 > view.byteLength) {
      throw fault(`CPU snapshot version does not own ${group} field ${name}`);
    }
    writePatchField(view, field, value, name);
  }
}

function writePatchField(
  view: DataView,
  field: PatchField,
  value: bigint,
  name: string,
): void {
  if (value < 0n || value >= 1n << BigInt(field.width)) {
    throw fault(`CPU patch has invalid ${name}`);
  }
  switch (field.width) {
    case 8:
      view.setUint8(field.offset, Number(value));
      break;
    case 16:
      view.setUint16(field.offset, Number(value), true);
      break;
    case 32:
      view.setUint32(field.offset, Number(value), true);
      break;
    case 64:
      view.setBigUint64(field.offset, value, true);
      break;
    case 80:
    case 128:
      view.setBigUint64(field.offset, value & ((1n << 64n) - 1n), true);
      view.setBigUint64(field.offset + 8, value >> 64n, true);
      break;
  }
}

function segmentPatchField(name: string): PatchField | undefined {
  const segments = ["cs", "ss", "ds", "es", "fs", "gs", "ldtr", "tr"];
  const index = segments.findIndex((segment) => name.startsWith(segment));
  if (index < 0) return undefined;
  const suffix = name.slice(segments[index]?.length);
  const field = (() => {
    switch (suffix) {
      case "Selector":
        return { offset: 0, width: 16 } as const;
      case "Base":
        return { offset: 2, width: 64 } as const;
      case "Limit":
        return { offset: 10, width: 32 } as const;
      case "Attributes":
        return { offset: 14, width: 16 } as const;
      default:
        return undefined;
    }
  })();
  return field === undefined
    ? undefined
    : {
        offset: SEGMENTS_OFFSET + index * SEGMENT_LENGTH + field.offset,
        width: field.width,
      };
}

function tablePatchField(name: string): PatchField | undefined {
  switch (name) {
    case "gdtrBase":
      return { offset: GDTR_OFFSET, width: 64 };
    case "gdtrLimit":
      return { offset: GDTR_OFFSET + 8, width: 16 };
    case "idtrBase":
      return { offset: IDTR_OFFSET, width: 64 };
    case "idtrLimit":
      return { offset: IDTR_OFFSET + 8, width: 16 };
    default:
      return undefined;
  }
}

function tssPatchField(name: string): PatchField | undefined {
  if (/^rsp[0-2]$/u.test(name)) {
    return {
      offset: TSS_OFFSET + Number(name.slice(3)) * 8,
      width: 64,
    };
  }
  if (/^ist[1-7]$/u.test(name)) {
    return {
      offset: TSS_OFFSET + 24 + (Number(name.slice(3)) - 1) * 8,
      width: 64,
    };
  }
  return name === "ioBitmapBase"
    ? { offset: TSS_OFFSET + 80, width: 16 }
    : undefined;
}

function controlPatchField(name: string): PatchField | undefined {
  if (name === "paePdpteLoaded") return { offset: 2980, width: 8 };
  if (/^dr[0-7]$/u.test(name)) {
    return {
      offset: DEBUG_OFFSET + Number(name.slice(2)) * 8,
      width: 64,
    };
  }
  const fields: Readonly<Record<string, number>> = {
    cr0: CR0_OFFSET,
    cr2: CR0_OFFSET + 8,
    cr3: CR3_OFFSET,
    cr4: CR4_OFFSET,
    cr8: CR4_OFFSET + 8,
    efer: EFER_OFFSET,
    star: EFER_OFFSET + 8,
    lstar: EFER_OFFSET + 16,
    cstar: EFER_OFFSET + 24,
    sfmask: EFER_OFFSET + 32,
    fsBase: EFER_OFFSET + 40,
    gsBase: EFER_OFFSET + 48,
    kernelGsBase: EFER_OFFSET + 56,
    tscAux: EFER_OFFSET + 64,
    sysenterCs: SYSENTER_OFFSET,
    sysenterEsp: SYSENTER_OFFSET + 8,
    sysenterEip: SYSENTER_OFFSET + 16,
    fixedCounter0: 2924,
    fixedCounterControl: 2932,
    perfGlobalControl: 2940,
    perfOverflowControl: 2956,
    debugControl: 2964,
    paePdpte0: 2988,
    paePdpte1: 2996,
    paePdpte2: 3004,
    paePdpte3: 3012,
  };
  const offset = fields[name];
  return offset === undefined ? undefined : { offset, width: 64 };
}

function vectorPatchField(name: string): PatchField | undefined {
  if (/^st[0-7]$/u.test(name)) {
    return {
      offset: X87_OFFSET + Number(name.slice(2)) * 16,
      width: 80,
    };
  }
  if (/^xmm(?:[0-9]|1[0-5])$/u.test(name)) {
    return {
      offset: ZMM_OFFSET + Number(name.slice(3)) * 64,
      width: 128,
    };
  }
  if (/^ymm(?:[0-9]|1[0-5])High$/u.test(name)) {
    return {
      offset: ZMM_OFFSET + Number(name.slice(3, -4)) * 64 + 16,
      width: 128,
    };
  }
  switch (name) {
    case "x87Control":
      return { offset: X87_OFFSET + 128, width: 16 };
    case "x87Status":
      return { offset: X87_OFFSET + 130, width: 16 };
    case "x87Tag":
      return { offset: X87_OFFSET + 132, width: 16 };
    case "x87Opcode":
      return { offset: X87_OFFSET + 134, width: 16 };
    case "x87InstructionPointer":
      return { offset: X87_OFFSET + 136, width: 64 };
    case "x87DataPointer":
      return { offset: X87_OFFSET + 144, width: 64 };
    case "x87InstructionSelector":
      return { offset: MXCSR_OFFSET + 4, width: 16 };
    case "x87DataSelector":
      return { offset: MXCSR_OFFSET + 6, width: 16 };
    case "mxcsr":
      return { offset: MXCSR_OFFSET, width: 32 };
    case "xcr0":
      return { offset: XCR0_OFFSET, width: 64 };
    case "xss":
      return { offset: XSS_OFFSET, width: 64 };
    case "xstateInUse":
      return { offset: 2916, width: 64 };
    default:
      return undefined;
  }
}

function eventPatchField(name: string): PatchField | undefined {
  switch (name) {
    case "interruptShadow":
      return { offset: EVENTS_OFFSET, width: 8 };
    case "nmiBlocked":
      return { offset: EVENTS_OFFSET + 1, width: 8 };
    case "deliveryDepth":
      return { offset: EVENTS_OFFSET + 2, width: 8 };
    default:
      return undefined;
  }
}

function userPageEntry(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== 8) {
    throw fault("diagnostic page-table entry has invalid length");
  }
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setBigUint64(0, view.getBigUint64(0, true) | 4n, true);
  return copy;
}

function decodeCpl(value: number): 0 | 1 | 2 | 3 {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
      return value;
    default:
      throw fault(`invalid CPL ${value}`);
  }
}

function decodeProfile(value: number): CoreProfile {
  switch (value) {
    case 0:
      return "baseline";
    case 1:
      return "x86-64-v2";
    case 2:
      return "x86-64-v3";
    default:
      throw fault(`invalid CPU profile ${value}`);
  }
}

function encodeProfile(profile: CoreProfile): number {
  switch (profile) {
    case "baseline":
      return 0;
    case "x86-64-v2":
      return 1;
    case "x86-64-v3":
      return 2;
  }
}

function decodeInterruptShadow(value: number): CoreInterruptShadow {
  switch (value) {
    case 0:
      return "none";
    case 1:
      return "sti";
    case 2:
      return "mov-ss";
    default:
      throw fault(`invalid interrupt shadow ${value}`);
  }
}

function decodeBoolean(value: number, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw fault(`CPU snapshot has invalid ${field}`);
}

function readMany<Value>(
  count: number,
  read: () => Value,
): readonly Value[] {
  return Array.from({ length: count }, read);
}
