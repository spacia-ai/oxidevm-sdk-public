import { PROTOCOL_VERSION } from "./common.ts";
import { USERSPACE_API_VERSION } from "../userspace-abi.js";
import { expect, it } from "vitest";
import { decodeNativeGraphVersion, NATIVE_LOGICAL_CHECKPOINT_VERSION, supportsNativeCheckpointVersion } from "./native-capture.js";

function graph(version: number): Uint8Array {
  const bytes = new Uint8Array(85);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, "OXUG"); view.setUint32(4, 1, true); view.setUint32(8, 2, true);
  view.setUint32(16, 49, true); tag(20, "OXWA"); view.setUint32(24, 1, true);
  view.setUint32(69, 1, true); view.setUint32(73, 8, true); tag(77, "OXUC");
  view.setUint16(81, version, true);
  return bytes;
}

it("admits native94 identity start ticks while keeping native93 checkpoints readable", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  for (const version of [93, 94]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits the combined native98 layout and retains both earlier source header versions", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  for (const version of [94, 97, 98]) expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  expect(() => decodeNativeGraphVersion(graph(100))).toThrow(/header is invalid/u);
});

it("admits native93 worker-limit cursors while retaining original native92 filter owners", () => {
  for (const version of [92, 93]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("preserves original exec generations with native92 while retaining native91", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  for (const version of [91,92]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native87 final registered-region prefixes within the existing graph framing", () => {
  expect(decodeNativeGraphVersion(graph(87))).toBe(87);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits native88 partial personality owners while retaining the 85-byte graph header", () => {
  expect(decodeNativeGraphVersion(graph(88))).toBe(88);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits native89 original filter program prefixes and native90 task pools", () => {
  expect(decodeNativeGraphVersion(graph(89))).toBe(89);
  expect(supportsNativeCheckpointVersion(90)).toBe(true);
  expect(decodeNativeGraphVersion(graph(90))).toBe(90);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("keeps historical checkpoint headers through cancellation version 42", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    const framed = new Uint8Array(100);
    framed.set(graph(version), 7);
    expect(decodeNativeGraphVersion(framed.subarray(7, 92))).toBe(version);
  }
  for (const version of [0, NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(false);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("retains native74/75 ownership and admits native76 caller continuations", () => {
  expect(supportsNativeCheckpointVersion(74)).toBe(true);
  expect(decodeNativeGraphVersion(graph(74))).toBe(74);
  expect(supportsNativeCheckpointVersion(75)).toBe(true);
  expect(decodeNativeGraphVersion(graph(75))).toBe(75);
  expect(supportsNativeCheckpointVersion(76)).toBe(true);
  expect(decodeNativeGraphVersion(graph(76))).toBe(76);
  expect(supportsNativeCheckpointVersion(77)).toBe(true);
  expect(decodeNativeGraphVersion(graph(77))).toBe(77);
  expect(supportsNativeCheckpointVersion(78)).toBe(true);
  expect(decodeNativeGraphVersion(graph(78))).toBe(78);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits prepared file-operation version 43 and durability continuation version 44", () => {
  expect(supportsNativeCheckpointVersion(43)).toBe(true);
  expect(decodeNativeGraphVersion(graph(43))).toBe(43);
  expect(supportsNativeCheckpointVersion(44)).toBe(true);
  expect(decodeNativeGraphVersion(graph(44))).toBe(44);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits mapping advice checkpoint 45 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(45)).toBe(true);
  expect(decodeNativeGraphVersion(graph(45))).toBe(45);
});

it("admits VMA policy checkpoint 46 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(46)).toBe(true);
  expect(decodeNativeGraphVersion(graph(46))).toBe(46);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits resumable population checkpoint 47", () => {
  expect(supportsNativeCheckpointVersion(47)).toBe(true);
  expect(decodeNativeGraphVersion(graph(47))).toBe(47);
});

it("admits classic provided buffers and removal cursors in checkpoint 48", () => {
  expect(supportsNativeCheckpointVersion(48)).toBe(true);
  expect(decodeNativeGraphVersion(graph(48))).toBe(48);
});

it("admits selected READ entries and retained completion flags in checkpoint 49", () => {
  expect(supportsNativeCheckpointVersion(49)).toBe(true);
  expect(decodeNativeGraphVersion(graph(49))).toBe(49);
});

it("admits full selected READV headers in checkpoint 50", () => {
  expect(supportsNativeCheckpointVersion(50)).toBe(true);
  expect(decodeNativeGraphVersion(graph(50))).toBe(50);
});

it("admits retained pollable reads in checkpoint 51 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(51)).toBe(true);
  expect(decodeNativeGraphVersion(graph(51))).toBe(51);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits pending counter, timer and inotify reads in checkpoint 52", () => {
  expect(supportsNativeCheckpointVersion(52)).toBe(true);
  expect(decodeNativeGraphVersion(graph(52))).toBe(52);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits attached setup state in checkpoint 53", () => {
  expect(supportsNativeCheckpointVersion(53)).toBe(true);
  expect(decodeNativeGraphVersion(graph(53))).toBe(53);
});

it("admits completed task work in checkpoint 54", () => {
  expect(supportsNativeCheckpointVersion(54)).toBe(true);
  expect(decodeNativeGraphVersion(graph(54))).toBe(54);
});

it("admits issuer-owned readiness reissue in checkpoint 55", () => {
  expect(supportsNativeCheckpointVersion(55)).toBe(true);
  expect(decodeNativeGraphVersion(graph(55))).toBe(55);
});

it("admits prepared exec cleanup in checkpoint 56", () => {
  expect(supportsNativeCheckpointVersion(56)).toBe(true);
  expect(decodeNativeGraphVersion(graph(56))).toBe(56);
});

it("admits committed exec failure checkpoint 60 while retaining native59 headers", () => {
  for (const version of [59, 60]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits bounded query native61 headers and rejects the next unknown version", () => {
  expect(supportsNativeCheckpointVersion(61)).toBe(true);
  expect(decodeNativeGraphVersion(graph(61))).toBe(61);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits selected fixed-buffer native63 headers and retains native61/62 compatibility", () => {
  for (const version of [61, 62, 63]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits tagged fixed-buffer native64 headers and rejects unknown future headers", () => {
  expect(supportsNativeCheckpointVersion(64)).toBe(true);
  expect(decodeNativeGraphVersion(graph(64))).toBe(64);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("preserves native94 combined resource records with the current worker", () => {
  expect(PROTOCOL_VERSION).toBe(175);
  expect(decodeNativeGraphVersion(graph(94))).toBe(94);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits retained TCP urgent marks in native95 and rejects newer socket graphs", () => {
  expect(PROTOCOL_VERSION).toBe(175);
  expect(decodeNativeGraphVersion(graph(95))).toBe(95);
  expect(decodeNativeGraphVersion(graph(94))).toBe(94);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits captured urgent notifications in native96 and rejects newer graphs", () => {
  expect(USERSPACE_API_VERSION).toBe(143);
  expect(PROTOCOL_VERSION).toBe(175);
  expect(decodeNativeGraphVersion(graph(96))).toBe(96);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("pairs retained urgent-pointer announcements with native97 and rejects future peers", () => {
  expect(USERSPACE_API_VERSION).toBe(143);
  expect(PROTOCOL_VERSION).toBe(175);
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  expect(decodeNativeGraphVersion(graph(97))).toBe(97);
  expect(decodeNativeGraphVersion(graph(96))).toBe(96);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native99 coarse-clock policy and retains native98 snapshots", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(99);
  for (const version of [97, 98, 99]) {
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(100))).toThrow(/header is invalid/u);
});
