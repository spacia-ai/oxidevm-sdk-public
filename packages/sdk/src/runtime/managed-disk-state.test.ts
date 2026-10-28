import assert from "node:assert/strict";
import { test } from "vitest";

import {
  managedBaseCacheEntryIsStale,
  managedBaseIsComplete,
  managedChunkPackIndex,
  managedChunkPackOffset,
  managedDirtyBitmapRange,
  managedDirtyBitmapUpdate,
  managedLeadingPartialLength,
  MANAGED_OVERLAY_SEGMENT_BYTES,
  managedReadRunLength,
  managedSegmentPosition,
  managedSegmentRunLength,
} from "./managed-disk-state.js";

test("managed base cleanup removes only obsolete builds of the same profile version", () => {
  const family = "alpine-2026.07.30-";
  const current = `${family}${"a".repeat(64)}`;
  const old = `${family}${"b".repeat(64)}`;
  const none = new Set<string>();

  assert.equal(managedBaseCacheEntryIsStale(`${old}.pack`, family, current, none), true);
  assert.equal(managedBaseCacheEntryIsStale(`${old}.complete`, family, current, none), true);
  assert.equal(managedBaseCacheEntryIsStale(`${old}.image.json`, family, current, none), true);
  assert.equal(managedBaseCacheEntryIsStale(`${old}.kernel`, family, current, none), true);
  assert.equal(managedBaseCacheEntryIsStale(`${old}.initrd`, family, current, none), true);
  assert.equal(managedBaseCacheEntryIsStale(`${current}.pack`, family, current, none), false);
  assert.equal(
    managedBaseCacheEntryIsStale(`alpine-2026.07.29-${"b".repeat(64)}.pack`, family, current, none),
    false,
  );
});

test("managed base cleanup keeps every file of an image a workspace pins", () => {
  const family = "alpine-2026.07.30-";
  const current = `${family}${"a".repeat(64)}`;
  const pinned = `${family}${"b".repeat(64)}`;

  for (const suffix of [".pack", ".complete", ".image.json", ".kernel", ".initrd"]) {
    assert.equal(managedBaseCacheEntryIsStale(`${pinned}${suffix}`, family, current, new Set([pinned])), false);
  }
});

test("managed disk requires both its exact length and completion marker", () => {
  const identity = "a".repeat(64);
  const marker = `${identity}:8192\n`;

  assert.equal(managedBaseIsComplete(8192, marker, 8192, identity), true);
  assert.equal(managedBaseIsComplete(8192, undefined, 8192, identity), false);
  assert.equal(managedBaseIsComplete(4096, marker, 8192, identity), false);
  assert.equal(
    managedBaseIsComplete(8192, `${"b".repeat(64)}:8192\n`, 8192, identity),
    false,
  );
});

test("packed base offsets preserve sparse logical chunk positions", () => {
  const packed = managedChunkPackIndex(5, [0, 2, 4]);

  assert.equal(managedChunkPackOffset(0, 4096, packed), 0);
  assert.equal(managedChunkPackOffset(4096, 4096, packed), undefined);
  assert.equal(managedChunkPackOffset(2 * 4096 + 7, 4096, packed), 4096 + 7);
  assert.equal(managedChunkPackOffset(4 * 4096, 4096, packed), 2 * 4096);
  assert.throws(() => managedChunkPackIndex(2, [1, 1]), RangeError);
});

test("managed reads coalesce blocks until source or packed chunk changes", () => {
  const dirty = new Set([2, 3]);
  const run = (offset: number, length: number) =>
    managedReadRunLength(
      offset,
      length,
      4096,
      16 * 1024,
      (block) => dirty.has(block),
    );

  assert.equal(run(1024, 16 * 1024), 7 * 1024);
  assert.equal(run(2 * 4096, 16 * 1024), 2 * 4096);
  assert.equal(run(4 * 4096, 32 * 1024), 16 * 1024);
});

test("managed writes isolate only their unaligned leading bytes", () => {
  assert.equal(managedLeadingPartialLength(4096, 8192, 4096), 0);
  assert.equal(managedLeadingPartialLength(4095, 8192, 4096), 1);
  assert.equal(managedLeadingPartialLength(7, 3, 4096), 3);
});

test("managed dirty updates are prepared without changing the committed bitmap", () => {
  const bitmap = Uint8Array.of(0b0000_0011, 0);
  const update = managedDirtyBitmapUpdate(bitmap, 7, 3);

  assert.deepEqual(bitmap, Uint8Array.of(0b0000_0011, 0));
  assert.ok(update);
  assert.equal(update.offset, 0);
  assert.deepEqual(update.bytes, Uint8Array.of(0b1000_0011, 0b0000_0011));
  assert.equal(managedDirtyBitmapUpdate(update.bytes, 7, 3), undefined);
  assert.throws(() => managedDirtyBitmapUpdate(bitmap, 15, 2), RangeError);
});

test("managed dirty bitmap ranges merge without losing disjoint updates", () => {
  let range = managedDirtyBitmapRange(undefined, 12, 3);
  assert.deepEqual(range, { offset: 12, length: 3 });
  range = managedDirtyBitmapRange(range, 4, 2);
  assert.deepEqual(range, { offset: 4, length: 11 });
  range = managedDirtyBitmapRange(range, 20, 4);
  assert.deepEqual(range, { offset: 4, length: 20 });
  assert.throws(() => managedDirtyBitmapRange(range, -1, 1), RangeError);
});

test("managed overlay segments keep native file offsets below one segment", () => {
  const segmentBytes = 1024 ** 3;
  const logical = 1081344 * 4096;

  assert.deepEqual(managedSegmentPosition(logical, segmentBytes), {
    index: 4,
    offset: 128 * 1024 * 1024,
  });
  assert.equal(
    managedSegmentRunLength(segmentBytes - 4096, 8192, segmentBytes),
    4096,
  );
});

test("managed overlay bounds a high-offset guest write to a small OPFS file", () => {
  const failureOffset = 902_561_792;
  const failureLength = 217_088;
  const position = managedSegmentPosition(
    failureOffset,
    MANAGED_OVERLAY_SEGMENT_BYTES,
  );

  assert.ok(MANAGED_OVERLAY_SEGMENT_BYTES <= 64 * 1024 * 1024);
  assert.ok(position.offset + failureLength <= MANAGED_OVERLAY_SEGMENT_BYTES);
});
