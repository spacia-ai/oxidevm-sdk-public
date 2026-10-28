import { expect, it, vi } from "vitest";
import { NativePayloadRounds } from "./snapshot-native-payload-rounds.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { checkpointHeader, encodeCheckpointDeclaration } from "./userspace-checkpoint.js";
import type { ObjectRef } from "./snapshot-manifest.js";
function stream(magic: "OXUP" | "OXUD", values: readonly { ref: bigint; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const head = checkpointHeader(magic, 16); new DataView(head.buffer).setBigUint64(8, BigInt(values.length), true);
  const length = 16 + values.reduce((n, value) => n + 24 + (magic === "OXUP" ? value.bytes.length : 0), 0);
  const output = new Uint8Array(length); output.set(head); let offset = 16;
  for (const value of values) {
    output.set(encodeCheckpointDeclaration({ reference: value.ref, kind: 0n, length: BigInt(value.bytes.length) }), offset); offset += 24;
    if (magic === "OXUP") { output.set(value.bytes, offset); offset += value.bytes.length; }
  }
  return output;
}
it("merges newest payload ranges, drops deleted refs and keeps all staged CAS objects reachable", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory());
  const rounds = new NativePayloadRounds(objects);
  const old = { ref: 1n, bytes: new Uint8Array(1024 * 1024 + 9).fill(1) };
  const removed = { ref: 2n, bytes: new Uint8Array([2]) };
  const changed = { ref: 1n, bytes: new Uint8Array(old.bytes.length).fill(3) };
  const added = { ref: 3n, bytes: new Uint8Array([4]) };
  for (const [ordinal, values] of [[0, [old, removed]], [1, [changed, added]]] as const) {
    const bytes = stream("OXUP", values); rounds.beginRound(ordinal);
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) await rounds.putRound(ordinal, offset / (1024 * 1024), bytes.slice(offset, offset + 1024 * 1024));
    await rounds.sealRound(ordinal, bytes.length);
  }
  const live = stream("OXUD", [changed, added]); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  expect([...rounds.objectRefs()].length).toBeGreaterThan(4);
  const chunks: Uint8Array[] = [];
  const total = await rounds.consolidate((index, bytes) => { expect(index).toBe(chunks.length); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); chunks.push(bytes); return Promise.resolve(); });
  const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  expect(output).toEqual(stream("OXUP", [changed, added]));
});
it("refuses missing final payloads, malformed ordering and an unbounded number of rounds", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  expect(() => rounds.beginRound(4)).toThrow();
  rounds.beginRound(0);
  const invalid = stream("OXUP", [{ ref: 2n, bytes: new Uint8Array() }, { ref: 1n, bytes: new Uint8Array() }]);
  await rounds.putRound(0, 0, invalid);
  await expect(rounds.sealRound(0, invalid.length)).rejects.toThrow();
  const missing = new NativePayloadRounds(objects), live = stream("OXUD", [{ ref: 1n, bytes: new Uint8Array([1]) }]);
  await missing.putLiveIndex(0, live); await missing.sealLiveIndex(live.length);
  await expect(missing.consolidate(() => Promise.resolve())).rejects.toThrow();
});

it("reads each source CAS chunk once when consolidating many small payloads", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  const values = Array.from({ length: 300 }, (_, index) => ({ ref: BigInt(index + 1), bytes: new Uint8Array(4096).fill(index % 256) }));
  const bytes = stream("OXUP", values); rounds.beginRound(0);
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) await rounds.putRound(0, offset / (1024 * 1024), bytes.slice(offset, offset + 1024 * 1024));
  await rounds.sealRound(0, bytes.length);
  const live = stream("OXUD", values); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  const reads = vi.spyOn(objects, "read");
  expect(await rounds.consolidate(() => Promise.resolve())).toBe(bytes.length);
  // One live index, one round index and one data chunk; indexing retained the other data chunk.
  expect(reads).toHaveBeenCalledTimes(3);
});

it("reuses unchanged aligned CAS chunks across incremental payload consolidation", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  const values = Array.from({ length: 1300 }, (_, index) => ({ ref: BigInt(index + 1), bytes: new Uint8Array(4096).fill(index % 256) }));
  const baseline = stream("OXUP", values), chunks = [];
  for (let offset = 0; offset < baseline.length; offset += 1024 * 1024) chunks.push({ index: chunks.length, ...await objects.put(baseline.slice(offset, offset + 1024 * 1024)) });
  await objects.verify(chunks);
  await rounds.setBaseline({ bytes: baseline.length, chunks });
  const changed = { ref: 651n, bytes: new Uint8Array(4096).fill(255) }, data = stream("OXUP", [changed]);
  rounds.beginRound(0); await rounds.putRound(0, 0, data); await rounds.sealRound(0, data.length);
  const expected = [...values]; expected[650] = changed;
  const live = stream("OXUD", expected); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  const result: ObjectRef[] = [], reused: ObjectRef[] = [], reads = vi.spyOn(objects, "read");
  const total = await rounds.consolidate(async (index, bytes) => { result[index] = await objects.put(bytes); },
    (index, ref) => { result[index] = ref; reused.push(ref); return Promise.resolve(); });
  expect(reused.length).toBeGreaterThanOrEqual(3);
  for (const ref of reused) expect(reads.mock.calls.some(([read]) => read.sha256 === ref.sha256)).toBe(false);
  const output = new Uint8Array(total); let offset = 0;
  for (const ref of result) { const bytes = await objects.read(ref); output.set(bytes, offset); offset += bytes.length; }
  expect(output).toEqual(stream("OXUP", expected));
}, 30_000);

it("keeps exact bytes when deletions and changed lengths shift reused payload ranges", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  const values = [
    { ref: 1n, bytes: new Uint8Array(2 * 1024 * 1024).fill(1) },
    { ref: 2n, bytes: new Uint8Array(4096).fill(2) },
    { ref: 3n, bytes: new Uint8Array(2 * 1024 * 1024).fill(3) },
  ];
  const baseline = stream("OXUP", values), chunks = [];
  for (let offset = 0; offset < baseline.length; offset += 1024 * 1024) chunks.push({ index: chunks.length, ...await objects.put(baseline.slice(offset, offset + 1024 * 1024)) });
  await rounds.setBaseline({ bytes: baseline.length, chunks });
  const changed = { ref: 3n, bytes: new Uint8Array(2 * 1024 * 1024 + 3).fill(4) }, added = { ref: 4n, bytes: new Uint8Array() };
  const update = stream("OXUP", [changed, added]); rounds.beginRound(0);
  for (let offset = 0; offset < update.length; offset += 1024 * 1024) await rounds.putRound(0, offset / (1024 * 1024), update.slice(offset, offset + 1024 * 1024));
  await rounds.sealRound(0, update.length);
  const expected = [values[0], changed, added].filter(value => value !== undefined);
  const live = stream("OXUD", expected); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  const result: ObjectRef[] = [];
  const total = await rounds.consolidate(async (index, bytes) => { result[index] = await objects.put(bytes); },
    (index, ref) => { result[index] = ref; return Promise.resolve(); });
  const output = new Uint8Array(total); let offset = 0;
  for (const ref of result) { const bytes = await objects.read(ref); output.set(bytes, offset); offset += bytes.length; }
  expect(output).toEqual(stream("OXUP", expected));
}, 30_000);

it("overlaps bounded reads when a deletion shifts all later chunk boundaries", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  const kept = { ref: 2n, bytes: new Uint8Array(4 * 1024 * 1024).fill(7) };
  for (let index = 0; index < 4; index++) kept.bytes.fill(index, index * 1024 * 1024, (index + 1) * 1024 * 1024);
  const baseline = stream("OXUP", [{ ref: 1n, bytes: new Uint8Array([1]) }, kept]), chunks = [];
  for (let offset = 0; offset < baseline.length; offset += 1024 * 1024) chunks.push({ index: chunks.length, ...await objects.put(baseline.slice(offset, offset + 1024 * 1024)) });
  await rounds.setBaseline({ bytes: baseline.length, chunks });
  const live = stream("OXUD", [kept]); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  const source = new Set(chunks.map(chunk => chunk.sha256)), read = objects.read.bind(objects);
  let reading = 0, peak = 0;
  vi.spyOn(objects, "read").mockImplementation(async ref => {
    if (!source.has(ref.sha256)) return read(ref);
    reading++; peak = Math.max(peak, reading);
    try { await Promise.resolve(); return await read(ref); } finally { reading--; }
  });
  const result: Uint8Array[] = [], reuse = vi.fn(() => Promise.resolve());
  const total = await rounds.consolidate((index, bytes) => { result[index] = bytes; return Promise.resolve(); }, reuse);
  expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4); expect(reuse).not.toHaveBeenCalled();
  const output = new Uint8Array(total); let offset = 0;
  for (const bytes of result) { output.set(bytes, offset); offset += bytes.length; }
  expect(output).toEqual(stream("OXUP", [kept]));
}, 30_000);

it("uses a committed baseline for unchanged objects and prunes its deleted identities", async () => {
  const objects = await SnapshotObjects.open(new MemoryDirectory()), rounds = new NativePayloadRounds(objects);
  const kept = { ref: 1n, bytes: new Uint8Array(3 * 1024 * 1024).fill(7) };
  const removed = { ref: 2n, bytes: new Uint8Array([2]) }, old = { ref: 3n, bytes: new Uint8Array([3]) };
  const bytes = stream("OXUP", [kept, removed, old]), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) chunks.push({ index: chunks.length, ...await objects.put(bytes.slice(offset, offset + 1024 * 1024)) });
  const reads = vi.spyOn(objects, "read");
  await rounds.setBaseline({ bytes: bytes.length, chunks });
  // Indexing skips unchanged bodies and reads only the chunks containing their declarations.
  expect(reads.mock.calls.length).toBeLessThan(chunks.length);
  const changed = { ref: 3n, bytes: new Uint8Array([4]) }, round = stream("OXUP", [changed]);
  rounds.beginRound(0); await rounds.putRound(0, 0, round); await rounds.sealRound(0, round.length);
  const live = stream("OXUD", [kept, changed]); await rounds.putLiveIndex(0, live); await rounds.sealLiveIndex(live.length);
  const result: Uint8Array[] = [];
  const total = await rounds.consolidate((_index, bytes) => { result.push(bytes); return Promise.resolve(); });
  const output = new Uint8Array(total); let offset = 0;
  for (const bytes of result) { output.set(bytes, offset); offset += bytes.length; }
  expect(output).toEqual(stream("OXUP", [kept, changed]));
  expect([...rounds.objectRefs()]).toEqual(expect.arrayContaining(chunks.map(chunk => chunk.sha256)));
  await expect(rounds.setBaseline({ bytes: bytes.length, chunks })).rejects.toThrow();
},30_000);
