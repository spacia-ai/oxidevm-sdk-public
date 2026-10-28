import type { SnapshotKind } from "../protocol.js";

const MINUTE = 60_000;
const SAFETY_POINTS = 3;
const BUCKETS = [
  { target: 15 * MINUTE, from: 5 * MINUTE, to: 30 * MINUTE },
  { target: 60 * MINUTE, from: 30 * MINUTE + 1, to: 120 * MINUTE },
] as const;
const EARLIER_TODAY = 120 * MINUTE;

/** Wall-clock time and the local midnight of a time, injected so retention is testable. */
export interface RetentionClock {
  readonly now: () => number;
  readonly startOfDay: (unixMs: number) => number;
}

export const SYSTEM_CLOCK: RetentionClock = {
  now: () => Date.now(),
  startOfDay: (unixMs) => new Date(unixMs).setHours(0, 0, 0, 0),
};

export interface RetentionCandidate {
  readonly mode?: "system" | "userspace";
  readonly id: string;
  readonly kind: SnapshotKind;
  readonly capturedAtUnixMs: number;
}

/**
 * The restore points a retention pass at `now` keeps (ADR 0014 R2): every named, imported and
 * shipped point; the newest automatic save; the automatic save closest to about 15 minutes and
 * about an hour ago; the oldest from earlier today (`startOfDay` gives the local midnight of a
 * time); the newest from yesterday; and the newest three safety points. A point captured after
 * `now` is never dropped, so a skewed clock cannot erase new saves.
 */
export function retainedSnapshots(
  points: readonly RetentionCandidate[],
  now: number,
  startOfDay: (unixMs: number) => number,
): Set<string> {
  return new Set(["system", "userspace"].flatMap((mode) => [...retainedRuntimeSnapshots(
    points.filter((point) => (point.mode ?? "system") === mode), now, startOfDay,
  )]));
}

function retainedRuntimeSnapshots(points: readonly RetentionCandidate[], now: number, startOfDay: (unixMs: number) => number): Set<string> {
  const kept = new Set<string>();
  for (const point of points) {
    if (point.kind === "named" || point.kind === "imported" || point.kind === "shipped" || point.capturedAtUnixMs > now) {
      kept.add(point.id);
    }
  }
  const newestFirst = [...points].sort((left, right) => right.capturedAtUnixMs - left.capturedAtUnixMs);
  for (const safety of newestFirst.filter((point) => point.kind === "safety").slice(0, SAFETY_POINTS)) {
    kept.add(safety.id);
  }
  const automatic = newestFirst.filter((point) => point.kind === "automatic" && point.capturedAtUnixMs <= now);
  const latest = automatic[0];
  if (latest !== undefined) kept.add(latest.id);
  for (const bucket of BUCKETS) {
    const closest = automatic
      .filter((point) => now - point.capturedAtUnixMs >= bucket.from && now - point.capturedAtUnixMs <= bucket.to)
      .sort((left, right) => distance(left, now, bucket.target) - distance(right, now, bucket.target))[0];
    if (closest !== undefined) kept.add(closest.id);
  }
  const today = startOfDay(now);
  const earlierToday = automatic.filter((point) => point.capturedAtUnixMs >= today && now - point.capturedAtUnixMs > EARLIER_TODAY).at(-1);
  if (earlierToday !== undefined) kept.add(earlierToday.id);
  const yesterday = startOfDay(today - 1);
  const lastYesterday = automatic.find((point) => point.capturedAtUnixMs >= yesterday && point.capturedAtUnixMs < today);
  if (lastYesterday !== undefined) kept.add(lastYesterday.id);
  return kept;
}

function distance(point: RetentionCandidate, now: number, target: number): number {
  return Math.abs(now - point.capturedAtUnixMs - target);
}
