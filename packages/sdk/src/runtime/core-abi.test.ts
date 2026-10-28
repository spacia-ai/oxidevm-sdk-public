import { describe, expect, it } from "vitest";

import {
  CORE_API_VERSION,
  CoreAbiError,
  JIT_API_VERSION,
  JIT_CONTEXT_LENGTH,
  cpuSnapshotFieldGroups,
  createDiagnosticCpuFixture,
  createDiagnosticLongModeFixture,
  decodeCpuSnapshot,
  decodeCpuTraceState,
  decodeJitAction,
  decodeRunResult,
  patchDiagnosticCpuFixture,
  unsignedWasmPointer,
} from "./core-abi.js";

const EMPTY_CPU_PATCH_GROUPS = {
  segments: {},
  tables: {},
  tss: {},
  control: {},
  vector: {},
  events: {},
} as const;

it("normalizes Wasm32 pointers whose high bit is set", () => {
  expect(unsignedWasmPointer(0x7fff_ffff)).toBe(0x7fff_ffff);
  expect(unsignedWasmPointer(-0x8000_0000)).toBe(0x8000_0000);
  expect(unsignedWasmPointer(-1)).toBe(0xffff_ffff);
});

describe("core ABI snapshot codec", () => {
  it("decodes the native Userspace flat ring-three snapshot only with its explicit owner context", () => {
    const snapshot = createDiagnosticCpuFixture(resetSnapshot(), "long", "x86-64-v2").cpuState;
    const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
    view.setUint8(158, 3);
    view.setBigUint64(408, view.getBigUint64(408, true) & ~0x8000_0000n, true);
    view.setBigUint64(432, view.getBigUint64(432, true) & ~0x20n, true);
    expect(() => decodeCpuSnapshot(snapshot)).toThrow(/EFER/u);
    expect(decodeCpuSnapshot(snapshot, "userspace").state).toMatchObject({ mode: "long", cpl: 3 });
    view.setUint8(158, 0);
    expect(() => decodeCpuSnapshot(snapshot, "userspace")).toThrow();
  });
  it("patches and projects each cached PAE root without reading changed PDPT memory", () => {
    const snapshot = new Uint8Array(3020);
    snapshot.set(resetSnapshot());
    const view = new DataView(snapshot.buffer);
    view.setUint16(4, 7, true);
    view.setUint32(8, 3008, true);
    const fixture = createDiagnosticCpuFixture(snapshot, "protected");
    const patched = patchDiagnosticCpuFixture(fixture, {
      ...EMPTY_CPU_PATCH_GROUPS,
      registers: {}, rip: 0x400n, rflags: 2n, cpl: 0,
      control: {
        cr0: 0x8000_0011n, cr3: 0x1040n, cr4: 0x20n,
        paePdpteLoaded: 1n, paePdpte0: 0x2001n, paePdpte1: 0x3001n,
        paePdpte2: 0x4001n, paePdpte3: 0x5001n,
      },
    });
    expect(cpuSnapshotFieldGroups(decodeCpuSnapshot(patched.cpuState)).control).toMatchObject({
      paePdpteLoaded: 1n, paePdpte0: 0x2001n, paePdpte1: 0x3001n,
      paePdpte2: 0x4001n, paePdpte3: 0x5001n,
    });
    expect(cpuSnapshotFieldGroups(decodeCpuSnapshot(snapshot)).control).toMatchObject({
      paePdpteLoaded: 0n, paePdpte0: 0n, paePdpte1: 0n, paePdpte2: 0n, paePdpte3: 0n,
    });
  });
  it("preserves and validates version-seven cached PAE entries", () => {
    const snapshot = new Uint8Array(3020);
    snapshot.set(resetSnapshot());
    const view = new DataView(snapshot.buffer);
    view.setUint16(4, 7, true);
    view.setUint32(8, 3008, true);
    expect(decodeCpuSnapshot(snapshot)).toMatchObject({ version: 7, paePdpte: null });
    snapshot[2980] = 1;
    const entries = [0x2001n, 0x3001n, 0x4001n, 0x5001n];
    entries.forEach((entry, index) => view.setBigUint64(2988 + index * 8, entry, true));
    expect(decodeCpuSnapshot(snapshot)).toMatchObject({ paePdpte: entries });
    for (let index = 0; index < 4; index += 1) {
      const original = view.getBigUint64(2988 + index * 8, true);
      for (const bit of [1, 2, 5, 6, 7, 8, 52, 63]) {
        view.setBigUint64(2988 + index * 8, original | (1n << BigInt(bit)), true);
        expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
      }
      view.setBigUint64(2988 + index * 8, original, true);
    }
    for (let index = 2981; index < 2988; index += 1) {
      snapshot[index] = 1;
      expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
      snapshot[index] = 0;
    }
    snapshot[2980] = 2;
    expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
    snapshot[2980] = 0;
    expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
  });
  it("decodes capability revisions and preserves historical snapshot capabilities", () => {
    const snapshot = new Uint8Array(2916);
    snapshot.set(resetSnapshot());
    const view = new DataView(snapshot.buffer);
    view.setUint16(4, 4, true);
    view.setUint32(8, 2904, true);
    snapshot[2908] = 1;
    expect(decodeCpuSnapshot(snapshot)).toMatchObject({ version: 4, capabilityRevision: 1 });
    expect(decodeCpuSnapshot(resetSnapshot())).toMatchObject({ version: 3, capabilityRevision: 0 });
    snapshot[2908] = 0;
    expect(decodeCpuSnapshot(snapshot)).toMatchObject({ capabilityRevision: 0 });
    for (const value of [2, 255]) {
      snapshot[2908] = value;
      expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
    }
    snapshot[2908] = 1;
    for (let index = 2909; index < snapshot.length; index += 1) {
      snapshot[index] = 1;
      expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
      snapshot[index] = 0;
    }
  });
  it("decodes a complete version-three CPU snapshot", () => {
    const snapshot = resetSnapshot();
    expect(decodeCpuSnapshot(snapshot)).toMatchObject({
      version: 3,
      halted: false,
      profile: "baseline",
      state: {
        rip: 0xfff0n,
        rflags: 2n,
        mode: "real",
        cpl: 0,
      },
    });
  });

  it("projects trace state without decoding unused vector state", () => {
    const snapshot = resetSnapshot();
    const decoded = decodeCpuSnapshot(snapshot);
    expect(decodeCpuTraceState(snapshot)).toEqual({
      rip: decoded.state.rip,
      rflags: decoded.state.rflags,
      cr3: decoded.control.cr3,
      cpl: decoded.state.cpl,
      mode: decoded.state.mode,
      registers: {
        rax: decoded.state.rax,
        rcx: decoded.state.rcx,
        rdx: decoded.state.rdx,
        rbx: decoded.state.rbx,
        rsp: decoded.state.rsp,
        rbp: decoded.state.rbp,
        rsi: decoded.state.rsi,
        rdi: decoded.state.rdi,
        r8: decoded.state.r8,
        r9: decoded.state.r9,
        r10: decoded.state.r10,
        r11: decoded.state.r11,
        r12: decoded.state.r12,
        r13: decoded.state.r13,
        r14: decoded.state.r14,
        r15: decoded.state.r15,
      },
    });
  });

  it("builds a valid identity-mapped diagnostic long-mode fixture", () => {
    const fixture = createDiagnosticLongModeFixture(resetSnapshot());
    const decoded = decodeCpuSnapshot(fixture.cpuState);

    expect(decoded.state.mode).toBe("long");
    expect(decoded.state.rip).toBe(0n);
    expect(fixture.programAddress).toBe(0n);
    expect(fixture.memory.map(({ address }) => address)).toEqual([
      0x20_0000n,
      0x20_1000n,
      0x20_2000n,
    ]);
  });

  it.each(["real", "protected", "compatibility", "long"] as const)(
    "builds a valid %s-mode conformance fixture",
    (mode) => {
      const fixture = createDiagnosticCpuFixture(resetSnapshot(), mode);
      const snapshot = decodeCpuSnapshot(fixture.cpuState);
      expect(snapshot.state.mode).toBe(mode);
      expect(snapshot.segments.cs.selector).toBe(0);
      expect(fixture.memory).toHaveLength(
        mode === "compatibility" || mode === "long" ? 3 : 0,
      );
    },
  );

  it("accepts the architectural VME, PVI, and PSE control bits", () => {
    const fixture = patchDiagnosticCpuFixture(
      createDiagnosticCpuFixture(resetSnapshot(), "protected"),
      {
        registers: {},
        rip: 0n,
        rflags: 2n,
        cpl: 3,
        ...EMPTY_CPU_PATCH_GROUPS,
        control: { cr4: 0x13n },
      },
    );
    expect(decodeCpuSnapshot(fixture.cpuState).control.cr4).toBe(0x13n);
  });

  it("patches validated conformance registers without changing the mode fixture", () => {
    const fixture = patchDiagnosticCpuFixture(
      createDiagnosticCpuFixture(resetSnapshot(), "long"),
      {
        profile: "x86-64-v2",
        registers: { rax: 0x1234n, r15: 0x5678n },
        rip: 0x1000n,
        rflags: 0x202n,
        cpl: 3,
        ...EMPTY_CPU_PATCH_GROUPS,
      },
    );
    expect(decodeCpuSnapshot(fixture.cpuState).state).toMatchObject({
      rax: 0x1234n,
      r15: 0x5678n,
      rip: 0x1000n,
      rflags: 0x202n,
      mode: "long",
      cpl: 3,
    });
    expect(decodeCpuSnapshot(fixture.cpuState).profile).toBe("x86-64-v2");
    expect(fixture.programAddress).toBe(0x1000n);
    expect(
      fixture.memory.every(
        (region) => ((region.bytes[0] ?? 0) & 4) !== 0,
      ),
    ).toBe(true);
  });

  it("patches every sparse conformance state group through the canonical snapshot", () => {
    const fixture = patchDiagnosticCpuFixture(
      createDiagnosticCpuFixture(resetSnapshot(), "long"),
      {
        registers: {},
        rip: 0x100n,
        rflags: 0x202n,
        cpl: 0,
        segments: {
          csSelector: 8n,
          ssSelector: 16n,
          fsBase: 0x1234n,
        },
        tables: { gdtrBase: 0x1000n, gdtrLimit: 0x17n },
        tss: { rsp0: 0x3000n, ist1: 0x4000n, ioBitmapBase: 0x68n },
        control: {
          cr2: 0xdeadn,
          fsBase: 0x1234n,
          sysenterEip: 0x5678n,
        },
        vector: {
          st0: 0x123n,
          x87Status: 1n,
          x87InstructionSelector: 8n,
          x87DataSelector: 16n,
          xmm0: 0x456n,
          ymm0High: 0x789n,
        },
        events: {
          interruptShadow: 1n,
          nmiBlocked: 1n,
          deliveryDepth: 255n,
        },
      },
    );
    const decoded = decodeCpuSnapshot(fixture.cpuState);
    expect(decoded).toMatchObject({
      segments: {
        cs: { selector: 8 },
        ss: { selector: 16 },
        fs: { base: 0x1234n },
      },
      gdtr: { base: 0x1000n, limit: 0x17 },
      tss: {
        rsp: [0x3000n, 0n, 0n],
        ist: [0x4000n, 0n, 0n, 0n, 0n, 0n, 0n],
        ioBitmapBase: 0x68,
      },
      control: { cr2: 0xdeadn },
      msrs: { fsBase: 0x1234n, sysenterEip: 0x5678n },
      events: {
        interruptShadow: "sti",
        nmiBlocked: true,
        deliveryDepth: 255,
      },
    });
    expect(decoded.vector.x87.registers[0]).toBe(0x123n);
    expect(decoded.vector.x87.status).toBe(1);
    expect(decoded.vector.x87.instructionSelector).toBe(8);
    expect(decoded.vector.x87.dataSelector).toBe(16);
    expect(decoded.vector.zmm[0]?.[0]).toBe(0x456n);
    expect(decoded.vector.zmm[0]?.[2]).toBe(0x789n);
    expect(cpuSnapshotFieldGroups(decoded)).toMatchObject({
      segments: { fsBase: 0x1234n },
      tables: { gdtrBase: 0x1000n },
      tss: { rsp0: 0x3000n },
      control: { cr2: 0xdeadn },
      vector: {
        st0: 0x123n,
        x87InstructionSelector: 8n,
        x87DataSelector: 16n,
        xmm0: 0x456n,
        ymm0High: 0x789n,
      },
      events: { interruptShadow: 1n, nmiBlocked: 1n, deliveryDepth: 255n },
    });
  });

  it("rejects invalid conformance CPU patches", () => {
    const fixture = createDiagnosticCpuFixture(resetSnapshot(), "long");
    expect(() =>
      patchDiagnosticCpuFixture(fixture, {
        registers: { unknown: 0n },
        rip: 0n,
        rflags: 2n,
        cpl: 0,
        ...EMPTY_CPU_PATCH_GROUPS,
      }),
    ).toThrow(CoreAbiError);
    expect(() =>
      patchDiagnosticCpuFixture(fixture, {
        registers: { rax: -1n },
        rip: 0n,
        rflags: 2n,
        cpl: 0,
        ...EMPTY_CPU_PATCH_GROUPS,
      }),
    ).toThrow(CoreAbiError);
    expect(() =>
      patchDiagnosticCpuFixture(fixture, {
        registers: {},
        rip: 0n,
        rflags: 2n,
        cpl: 0,
        ...EMPTY_CPU_PATCH_GROUPS,
        segments: { unknown: 0n },
      }),
    ).toThrow(CoreAbiError);
    expect(() =>
      patchDiagnosticCpuFixture(fixture, {
        registers: {},
        rip: 0n,
        rflags: 2n,
        cpl: 0,
        ...EMPTY_CPU_PATCH_GROUPS,
        events: { nmiBlocked: 2n },
      }),
    ).toThrow(CoreAbiError);
    expect(() =>
      patchDiagnosticCpuFixture(fixture, {
        registers: {},
        rip: 0n,
        rflags: 2n,
        cpl: 0,
        ...EMPTY_CPU_PATCH_GROUPS,
        events: { deliveryDepth: 256n },
      }),
    ).toThrow(CoreAbiError);
  });

  it("migrates version-one snapshots with clear delivery state", () => {
    const snapshot = resetSnapshot().slice(0, -28);
    const view = new DataView(snapshot.buffer);
    view.setUint16(4, 1, true);
    view.setUint32(8, 2868, true);

    expect(decodeCpuSnapshot(snapshot)).toMatchObject({
      version: 1,
      vector: {
        x87: {
          instructionSelector: 0,
          dataSelector: 0,
        },
      },
      events: {
        interruptShadow: "none",
        nmiBlocked: false,
        deliveryDepth: 0,
      },
    });
  });

  it("migrates version-two snapshots with clear SYSENTER state", () => {
    const snapshot = resetSnapshot().slice(0, -24);
    const view = new DataView(snapshot.buffer);
    view.setUint16(4, 2, true);
    view.setUint32(8, 2872, true);

    expect(decodeCpuSnapshot(snapshot)).toMatchObject({
      version: 2,
      msrs: {
        sysenterCs: 0n,
        sysenterEsp: 0n,
        sysenterEip: 0n,
      },
    });
  });

  it.each([
    new Uint8Array(),
    resetSnapshot().subarray(0, 2907),
    withByte(resetSnapshot(), 0, 0),
    withByte(resetSnapshot(), 4, 4),
    withByte(resetSnapshot(), 6, 1),
    withByte(resetSnapshot(), 2883, 1),
    withU64(resetSnapshot(), 408, 0x6000_0050n),
    withU64(createDiagnosticLongModeFixture(resetSnapshot()).cpuState, 424, 1n << 63n),
    withU64(resetSnapshot(), 432, 1n << 63n),
    withU64(resetSnapshot(), 520, 1n << 9n),
    withU64(resetSnapshot(), 560, 1n << 47n),
    withU64(resetSnapshot(), 584, 1n << 32n),
    withU64(resetSnapshot(), 2884, 1n << 16n),
  ])("rejects malformed snapshot records", (snapshot) => {
    expect(() => decodeCpuSnapshot(snapshot)).toThrow(CoreAbiError);
  });
});

describe("core ABI run-result codec", () => {
  it("decodes normal, exception, reset, and adapter exits", () => {
    expect(decodeRunResult(runResult(0))).toEqual({
      kind: "halted",
      steps: 7n,
    });

    const exception = runResult(2);
    const view = new DataView(exception.buffer);
    exception[24] = 14;
    exception[26] = 3;
    view.setUint32(28, 5, true);
    view.setBigUint64(32, 0x1234n, true);
    view.setBigUint64(40, 0x5678n, true);
    expect(decodeRunResult(exception)).toEqual({
      kind: "exception",
      steps: 7n,
      exception: {
        vector: { name: "#PF", number: 14 },
        class: "fault",
        errorCode: 5,
        faultAddress: 0x1234n,
        instructionRip: 0x5678n,
      },
    });

    const reset = runResult(3);
    reset[24] = 1;
    expect(decodeRunResult(reset)).toEqual({
      kind: "reset",
      steps: 7n,
      reason: "external-reset",
    });
    expect(decodeRunResult(runResult(4))).toEqual({
      kind: "adapter-exit",
      steps: 7n,
    });
  });

  it.each([
    new Uint8Array(),
    runResult(0).subarray(0, 47),
    withByte(runResult(0), 0, 0),
    withByte(runResult(0), 4, 3),
    withByte(runResult(0), 6, 1),
    withByte(runResult(0), 13, 1),
    withByte(runResult(2), 26, 4),
  ])("rejects malformed run-result records", (record) => {
    expect(() => decodeRunResult(record)).toThrow(CoreAbiError);
  });
});

describe("core ABI JIT-action codec", () => {
  it("matches the 64K direct-dispatch context layout", () => {
    expect(CORE_API_VERSION).toBe(19);
    expect(JIT_API_VERSION).toBe(93);
    expect(JIT_CONTEXT_LENGTH).toBe(6_315_496);
  });

  it("decodes compile, install-only, and interpreter actions", () => {
    expect(decodeJitAction(jitAction(0))).toEqual({
      kind: "compile",
      instructionCount: 4096,
      startRip: 0x1234n,
      cacheKey: 0x5678n,
      moduleLength: 99,
      artifactCacheKey: 0x5678n,
      artifactModuleLength: 99,
      contextLength: JIT_CONTEXT_LENGTH,
      maximumInstructions: 100,
    });
    expect(decodeJitAction(jitAction(1))).toEqual({
      kind: "interpreted-result",
      instructionCount: 7,
      startRip: 0x1234n,
      maximumInstructions: 100,
      reason: "unsupported-form",
    });
    expect(decodeJitAction(jitAction(2))).toEqual({
      kind: "install",
      instructionCount: 4096,
      startRip: 0x1234n,
      cacheKey: 0x5678n,
      moduleLength: 99,
      artifactCacheKey: 0x5678n,
      artifactModuleLength: 99,
      contextLength: JIT_CONTEXT_LENGTH,
      maximumInstructions: 100,
    });
    const aotInstall = jitAction(2);
    new DataView(aotInstall.buffer).setUint32(36, 0, true);
    expect(decodeJitAction(aotInstall)).toEqual({
      kind: "install",
      instructionCount: 4096,
      startRip: 0x1234n,
      cacheKey: 0x5678n,
      moduleLength: 0,
      artifactCacheKey: 0x5678n,
      artifactModuleLength: 0,
      contextLength: JIT_CONTEXT_LENGTH,
      maximumInstructions: 100,
    });
  });

  it("decodes the Userspace artifact identity without changing system action v6", () => {
    expect(decodeJitAction(ownerJitAction())).toEqual({
      kind: "compile",
      instructionCount: 4096,
      startRip: 0x1234n,
      cacheKey: 0x5678n,
      moduleLength: 99,
      artifactCacheKey: 0x9abcn,
      artifactModuleLength: 83,
      contextLength: JIT_CONTEXT_LENGTH,
      maximumInstructions: 100,
    });
  });

  it.each([
    new Uint8Array(),
    jitAction(0).subarray(0, 47),
    withByte(jitAction(0), 4, 1),
    withByte(jitAction(0), 14, 1),
    withByte(jitAction(0), 13, 1),
    withByte(jitAction(0), 17, 0),
    withByte(jitAction(0), 41, 0),
    withByte(jitAction(1), 28, 1),
    withByte(jitAction(1), 44, 0),
    withByte(jitAction(1), 16, 101),
    withByte(jitAction(1), 13, 255),
    withByte(jitAction(1), 12, 3),
  ])("rejects malformed JIT actions", (record) => {
    expect(() => decodeJitAction(record)).toThrow(CoreAbiError);
  });

  it.each([
    withU64(ownerJitAction(), 48, 0n),
    withByte(ownerJitAction(), 56, 0),
    withByte(ownerJitAction(), 56, 100),
    withByte(ownerJitAction(), 60, 1),
    withByte(ownerJitAction(), 8, 36),
  ])("rejects malformed Userspace artifact identities", (record) => {
    expect(() => decodeJitAction(record)).toThrow(CoreAbiError);
  });
});

function resetSnapshot(): Uint8Array {
  const snapshot = new Uint8Array(2908);
  const view = new DataView(snapshot.buffer);
  snapshot.set([0x4f, 0x58, 0x43, 0x50]);
  view.setUint16(4, 3, true);
  view.setUint32(8, 2896, true);
  view.setBigUint64(140, 0xfff0n, true);
  view.setBigUint64(148, 2n, true);

  for (let segment = 0; segment < 8; segment += 1) {
    const offset = 160 + segment * 16;
    view.setUint32(offset + 10, 0xffff, true);
    view.setUint16(
      offset + 14,
      segment === 0 ? 0x009b : segment === 6 ? 0x0082 : segment === 7 ? 0x008b : 0x0093,
      true,
    );
  }
  view.setBigUint64(408, 0x6000_0010n, true);
  view.setBigUint64(504, 0xffff_0ff0n, true);
  view.setBigUint64(512, 0x400n, true);
  view.setUint16(720, 0x037f, true);
  view.setUint16(724, 0xffff, true);
  view.setUint32(2856, 0x1f80, true);
  view.setBigUint64(2864, 1n, true);
  return snapshot;
}

function runResult(kind: number): Uint8Array {
  const record = new Uint8Array(48);
  const view = new DataView(record.buffer);
  record.set([0x4f, 0x58, 0x52, 0x52]);
  view.setUint16(4, 1, true);
  view.setUint32(8, 36, true);
  record[12] = kind;
  view.setBigUint64(16, 7n, true);
  return record;
}

function jitAction(kind: number): Uint8Array {
  const record = new Uint8Array(48);
  const view = new DataView(record.buffer);
  record.set([0x4f, 0x58, 0x4a, 0x41]);
  view.setUint16(4, 6, true);
  view.setUint32(8, 36, true);
  record[12] = kind;
  view.setBigUint64(20, 0x1234n, true);
  if (kind === 0 || kind === 2) {
    view.setUint32(16, 4096, true);
    view.setBigUint64(28, 0x5678n, true);
    view.setUint32(36, 99, true);
    view.setUint32(40, JIT_CONTEXT_LENGTH, true);
    view.setUint32(44, 100, true);
  } else {
    record[13] = 8;
    view.setUint32(16, 7, true);
    view.setUint32(44, 100, true);
  }
  return record;
}

function ownerJitAction(): Uint8Array {
  const record = new Uint8Array(64);
  const view = new DataView(record.buffer);
  record.set([0x4f, 0x58, 0x4a, 0x41]);
  view.setUint16(4, 7, true);
  view.setUint32(8, 52, true);
  record[12] = 0;
  view.setUint32(16, 4096, true);
  view.setBigUint64(20, 0x1234n, true);
  view.setBigUint64(28, 0x5678n, true);
  view.setUint32(36, 99, true);
  view.setUint32(40, JIT_CONTEXT_LENGTH, true);
  view.setUint32(44, 100, true);
  view.setBigUint64(48, 0x9abcn, true);
  view.setUint32(56, 83, true);
  return record;
}

function withByte(source: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = source.slice();
  copy[offset] = value;
  return copy;
}

function withU64(
  source: Uint8Array,
  offset: number,
  value: bigint,
): Uint8Array {
  const copy = source.slice();
  new DataView(copy.buffer).setBigUint64(offset, value, true);
  return copy;
}
