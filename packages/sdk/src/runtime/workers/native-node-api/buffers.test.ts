import { expect, it } from "vitest";
import { lateFailureOf } from "../../js-process/late-failure.js";
import { NativeBuffers } from "./buffers.js";

function pushes(buffers: NativeBuffers): { identity: number; bytes: number[] }[] {
  const result: { identity: number; bytes: number[] }[] = [];
  buffers.changes((identity, bytes) => { result.push({ identity, bytes: [...bytes] }); });
  return result;
}

for (const length of [0, 1, 7, 8, 9, 16, 17, 4097]) it(`operation set 2 hands over a JavaScript change to a ${String(length)}-byte buffer exactly once`, () => {
  const buffers = new NativeBuffers(() => undefined, true), value = new Uint8Array(length), { identity } = buffers.inspect(value);
  expect(pushes(buffers)).toEqual([]);
  for (const index of new Set([0, length >> 1, length - 1])) {
    if (index < 0 || index >= length) continue;
    value[index] = (value[index] ?? 0) ^ 0x5a;
    expect(pushes(buffers)).toEqual([{ identity, bytes: [...value] }]);
    expect(pushes(buffers)).toEqual([]);
  }
});

it("operation set 2 lets native code change a buffer JavaScript made, and refuses a change on both sides", () => {
  const buffers = new NativeBuffers(() => undefined, true), backing = new ArrayBuffer(16), view = new Uint16Array(backing, 4, 3);
  const { identity } = buffers.inspect(view), native = new Uint8Array(16).fill(7);
  buffers.update(identity, native);
  expect(new Uint8Array(backing)).toEqual(native); expect(pushes(buffers)).toEqual([]);
  view[0] = 0x1234;
  expect(() => { buffers.update(identity, new Uint8Array(16)); }).toThrow(/concurrent/u);
  expect(view[0]).toBe(0x1234);
  expect(pushes(buffers)).toEqual([{ identity, bytes: [...new Uint8Array(backing)] }]);
  buffers.update(identity, new Uint8Array(16));
  expect(new Uint8Array(backing)).toEqual(new Uint8Array(16));
  expect(() => { buffers.update(identity, new Uint8Array(15)); }).toThrow(/length/u);
});

it("operation set 2 hands over only the buffers that changed and skips a detached one", () => {
  const buffers = new NativeBuffers(() => undefined, true), kept = new Uint8Array(9), changed = new Uint8Array(9), moved = new Uint8Array(9);
  buffers.inspect(kept); const { identity } = buffers.inspect(changed); buffers.inspect(moved);
  changed[8] = 1; moved[0] = 1; structuredClone(moved.buffer, { transfer: [moved.buffer] });
  expect(pushes(buffers)).toEqual([{ identity, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 1] }]);
});

it("earlier operation sets keep one-way buffers: no handover, and a buffer JavaScript made stays read-only", () => {
  const buffers = new NativeBuffers(() => undefined), value = new Uint8Array(8), { identity } = buffers.inspect(value);
  value[0] = 1; expect(pushes(buffers)).toEqual([]);
  expect(() => { buffers.update(identity, new Uint8Array(8)); }).toThrow(/read-only/u);
  const owned = buffers.create(2, new Uint8Array([7, 8]));
  owned.value[0] = 9; expect(pushes(buffers)).toEqual([]);
  expect(() => { buffers.update(owned.identity, new Uint8Array(2)); }).toThrow(/concurrent/u);
});

it("refuses a buffer that takes the shared bytes over the launch's budget, as a limitation the next run remembers", () => {
  const buffers = new NativeBuffers(() => undefined, true, 16);
  const first = new Uint8Array(10); buffers.inspect(first);
  // A buffer already shared is not counted twice.
  expect(() => buffers.inspect(first)).not.toThrow();
  expect(() => buffers.inspect(new Uint8Array(6))).not.toThrow();
  let error: unknown;
  try { buffers.inspect(new Uint8Array(1)); } catch (caught) { error = caught; }
  expect(lateFailureOf(error)).toEqual({ kind: "shared-buffer-budget", detail: "17 of 16 bytes" });
  expect(() => buffers.create(1)).toThrow(/budget/u);
  expect(() => buffers.inspectBytes(new ArrayBuffer(1))).toThrow(/budget/u);
});

it("counts bytes back into the budget when a shared buffer is released", () => {
  const released: number[] = [], buffers = new NativeBuffers(identity => { released.push(identity); }, true, 16);
  buffers.inspect(new Uint8Array(16)); buffers.dispose();
  expect(released).toHaveLength(1);
  expect(() => buffers.inspect(new Uint8Array(16))).not.toThrow();
});

it("keeps the bridge's own limit, not a remembered limitation, without a budget below it", () => {
  const buffers = new NativeBuffers(() => undefined, true);
  let error: unknown;
  try { buffers.inspectBytes(new ArrayBuffer(128 * 1024 * 1024 + 1)); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect(lateFailureOf(error)).toBeUndefined();
});
