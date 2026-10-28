import { describe, expect, it } from "vitest";

import type { SnapshotKind } from "../protocol.js";
import { retainedSnapshots } from "./snapshot-retention.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const MINUTE = 60_000;
const utcDayStart = (ms: number): number => ms - (ms % 86_400_000);

function point(id: string, kind: SnapshotKind, at: string): { id: string; kind: SnapshotKind; capturedAtUnixMs: number } {
  return { id, kind, capturedAtUnixMs: Date.parse(at) };
}

describe("restore point retention", () => {
  it("keeps the latest automatic save, one per time bucket, three safety points and every named one", () => {
    const points = [
      point("latest", "automatic", "2026-10-02T14:58:00.000Z"),
      point("ten-minutes", "automatic", "2026-10-02T14:50:00.000Z"),
      point("sixteen-minutes", "automatic", "2026-10-02T14:44:00.000Z"),
      point("half-hour", "automatic", "2026-10-02T14:30:00.000Z"),
      point("fifty-five-minutes", "automatic", "2026-10-02T14:05:00.000Z"),
      point("sixty-two-minutes", "automatic", "2026-10-02T13:58:00.000Z"),
      point("late-morning", "automatic", "2026-10-02T11:00:00.000Z"),
      point("morning", "automatic", "2026-10-02T09:30:00.000Z"),
      point("yesterday-evening", "automatic", "2026-10-01T18:00:00.000Z"),
      point("yesterday-morning", "automatic", "2026-10-01T08:00:00.000Z"),
      point("two-days-ago", "automatic", "2026-09-30T12:00:00.000Z"),
      point("safety-1", "safety", "2026-10-02T10:00:00.000Z"),
      point("safety-2", "safety", "2026-10-02T11:00:00.000Z"),
      point("safety-3", "safety", "2026-10-02T12:00:00.000Z"),
      point("safety-4", "safety", "2026-10-02T13:00:00.000Z"),
      point("named", "named", "2026-09-28T12:00:00.000Z"),
      point("imported", "imported", "2026-09-01T12:00:00.000Z"),
      point("shipped", "shipped", "2026-08-01T12:00:00.000Z"),
    ];

    const kept = retainedSnapshots(points, NOW, utcDayStart);

    expect([...kept].sort()).toEqual([
      "imported",
      "latest",
      "morning",
      "named",
      "safety-2",
      "safety-3",
      "safety-4",
      "shipped",
      "sixteen-minutes",
      "sixty-two-minutes",
      "yesterday-evening",
    ]);
  });

  it("keeps a lone automatic save however old it is", () => {
    const kept = retainedSnapshots([point("only", "automatic", "2026-07-01T00:00:00.000Z")], NOW, utcDayStart);

    expect([...kept]).toEqual(["only"]);
  });

  it("keeps nothing when there is nothing", () => {
    expect(retainedSnapshots([], NOW, utcDayStart).size).toBe(0);
  });

  it("never drops a point captured after now, so a skewed clock cannot erase new saves", () => {
    const kept = retainedSnapshots([
      point("future", "automatic", "2026-10-02T16:00:00.000Z"),
      point("latest", "automatic", "2026-10-02T14:58:00.000Z"),
    ], NOW, utcDayStart);

    expect([...kept].sort()).toEqual(["future", "latest"]);
  });

  it("drops an automatic save that is neither the latest nor in any bucket", () => {
    const kept = retainedSnapshots([
      point("latest", "automatic", new Date(NOW - MINUTE).toISOString()),
      point("three-minutes", "automatic", new Date(NOW - 3 * MINUTE).toISOString()),
    ], NOW, utcDayStart);

    expect([...kept]).toEqual(["latest"]);
  });
});
