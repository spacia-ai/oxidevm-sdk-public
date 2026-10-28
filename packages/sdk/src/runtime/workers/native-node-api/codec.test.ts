import { expect, it } from "vitest";
import { decodeCapturedNativeFrame, decodeNativeFrame, encodeNativeFrame, NATIVE_MAX_FRAME, type NativeFrame } from "./codec.js";
import { JS_MAILBOX_BYTES } from "../../js-process/codec.js";

it("carries a large native payload without increasing Linux mailbox transfer bounds", () => {
  const frame: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_string_utf8", status: 0, args: [], bytes: new Uint8Array(JS_MAILBOX_BYTES + 1).fill(120) };
  const encoded = encodeNativeFrame(frame);
  expect(new DataView(encoded.buffer).getUint32(8, true)).toBe(15);
  const decoded = decodeNativeFrame(encoded.subarray(4));
  const { bytes: payload, ...fields } = decoded, { bytes: expectedPayload, ...expected } = frame;
  expect(fields).toEqual(expected);
  expect(payload.byteLength).toBe(expectedPayload.byteLength);
  expect(payload.every((byte, index) => byte === expectedPayload[index])).toBe(true);
  for (const version of [12, 13, 14, 16]) {
    const wrongVersion = encoded.slice(4); new DataView(wrongVersion.buffer).setUint32(4, version, true);
    expect(() => decodeNativeFrame(wrongVersion)).toThrow(/version/u);
  }
  expect(() => encodeNativeFrame({ ...frame, bytes: new Uint8Array(NATIVE_MAX_FRAME) })).toThrow(/exceeds/u);
});

it("preserves module identity only on Node-API request and response frames", () => {
  const frame: NativeFrame = { kind: 3, sequence: 1, scope: 1n, environment: 0x25_0000_0001n, operation: "napi_get_undefined", status: 0, args: [], bytes: new Uint8Array() };
  expect(decodeNativeFrame(encodeNativeFrame(frame).subarray(4))).toEqual(frame);
  expect(() => encodeNativeFrame({ ...frame, kind: 1 })).toThrow(/environment/u);
  expect(() => encodeNativeFrame({ ...frame, environment: -1n })).toThrow(/environment/u);
  expect(() => encodeNativeFrame({ ...frame, environment: 0x8000_0000_0000_0000n })).toThrow(/environment/u);
});

it("accepts the complete stable status range and rejects unknown statuses", () => {
  const frame: NativeFrame = { kind: 4, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_external_buffer", status: 0, args: [], bytes: new Uint8Array() };
  for (const status of [22, 23]) expect(decodeNativeFrame(encodeNativeFrame({ ...frame, status }).subarray(4)).status).toBe(status);
  expect(() => encodeNativeFrame({ ...frame, status: 24 })).toThrow(/status/u);
});

it("decodes historical frames only through the explicit captured-version boundary", () => {
  const frame: NativeFrame = { kind: 4, sequence: 1, scope: 1n, environment: 1n, operation: "register-environment", status: 0, args: [0n], bytes: new Uint8Array() };
  const bytes = encodeNativeFrame(frame).slice(4); new DataView(bytes.buffer).setUint32(4, 13, true);
  expect(decodeCapturedNativeFrame(bytes, 13)).toEqual(frame);
  expect(() => decodeNativeFrame(bytes)).toThrow(/version/u);
  expect(() => decodeCapturedNativeFrame(bytes, 14)).toThrow(/version/u);
  new DataView(bytes.buffer).setUint32(4, 12, true);
  expect(() => decodeCapturedNativeFrame(bytes, 13)).toThrow(/version/u);
});
