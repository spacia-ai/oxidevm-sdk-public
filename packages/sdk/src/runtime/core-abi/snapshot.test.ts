import { expect, it } from "vitest";
import {
  CoreAbiError,
  createDiagnosticCpuFixture,
  decodeCpuSnapshot,
  patchDiagnosticCpuFixture,
} from "../core-abi.js";

function snapshot(): Uint8Array {
  const bytes = new Uint8Array(2924);
  bytes.set([0x4f, 0x58, 0x43, 0x50]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 5, true);
  view.setUint32(8, 2912, true);
  view.setBigUint64(148, 2n, true);
  view.setBigUint64(408, 0x10n, true);
  view.setBigUint64(2864, 1n, true);
  bytes[2908] = 1;
  view.setBigUint64(2916, 7n, true);
  return bytes;
}

function pmuSnapshot(): Uint8Array {
  const bytes = new Uint8Array(2980);
  bytes.set(snapshot());
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 6, true);
  view.setUint32(8, 2968, true);
  bytes[159] = 2;
  view.setBigUint64(2924, 0xabcd_ffff_ffffn, true);
  view.setBigUint64(2932, 0xbn, true);
  view.setBigUint64(2940, 1n << 32n, true);
  view.setBigUint64(2948, (1n << 32n) | (1n << 63n), true);
  view.setBigUint64(2964, 1n << 12n, true);
  bytes[2972] = 1;
  return bytes;
}

it("decodes the fixed PMU snapshot and rejects reserved or unavailable state", () => {
  expect(decodeCpuSnapshot(pmuSnapshot())).toMatchObject({
    version: 6, performance: {
      fixedCounter0: 0xabcd_ffff_ffffn, fixedCounterControl: 0xbn,
      perfGlobalControl: 1n << 32n, perfGlobalStatus: (1n << 32n) | (1n << 63n),
      perfOverflowControl: 0n, debugControl: 1n << 12n, pmiPending: true,
    },
  });
  expect(decodeCpuSnapshot(snapshot())).toMatchObject({
    version: 5, performance: { fixedCounter0: 0n, pmiPending: false },
  });
  for (const [offset, value] of [[2930, 1], [2932, 4], [2940, 1], [2948, 1], [2956, 1], [2964, 1], [2972, 2], [2973, 1], [159, 0]] as const) {
    const invalid = pmuSnapshot();
    invalid[offset] = value;
    expect(() => decodeCpuSnapshot(invalid)).toThrow(CoreAbiError);
  }
});

it("patches diagnostic PMU fields through the validated snapshot", () => {
  const patch = { registers: {}, rip: 0n, rflags: 2n, cpl: 0,
    segments: {}, tables: {}, tss: {}, control: { fixedCounter0: 17n }, events: {}, vector: {},
  } as const;
  expect(decodeCpuSnapshot(patchDiagnosticCpuFixture(
    createDiagnosticCpuFixture(pmuSnapshot(), "long", "x86-64-v3"), patch,
  ).cpuState)).toMatchObject({ performance: { fixedCounter0: 17n } });
  expect(() => patchDiagnosticCpuFixture(createDiagnosticCpuFixture(snapshot(), "long"), patch)).toThrow(CoreAbiError);
});

it("retains restored component state across current and historical snapshots", () => {
  const current = snapshot();
  expect(decodeCpuSnapshot(current)).toMatchObject({
    version: 5, capabilityRevision: 1, vector: { xstateInUse: 7n },
  });
  const historical = current.slice(0, 2916);
  const view = new DataView(historical.buffer);
  view.setUint16(4, 4, true);
  view.setUint32(8, 2904, true);
  expect(decodeCpuSnapshot(historical)).toMatchObject({
    version: 4, capabilityRevision: 1, vector: { xstateInUse: 0n },
  });
  const invalid = snapshot();
  new DataView(invalid.buffer).setBigUint64(2916, 8n, true);
  expect(() => decodeCpuSnapshot(invalid)).toThrow(CoreAbiError);
});

it("patches component state only when the snapshot version owns that field", () => {
  const patch = {
    registers: {}, rip: 0n, rflags: 2n, cpl: 0,
    segments: {}, tables: {}, tss: {}, control: {}, events: {},
    vector: { xstateInUse: 6n },
  } as const;
  const current = createDiagnosticCpuFixture(snapshot(), "long");
  expect(decodeCpuSnapshot(patchDiagnosticCpuFixture(current, patch).cpuState)
    .vector.xstateInUse).toBe(6n);
  const historical = snapshot().slice(0, 2916);
  const view = new DataView(historical.buffer);
  view.setUint16(4, 4, true);
  view.setUint32(8, 2904, true);
  expect(() => patchDiagnosticCpuFixture(
    createDiagnosticCpuFixture(historical, "long"), patch,
  )).toThrow(CoreAbiError);
});
