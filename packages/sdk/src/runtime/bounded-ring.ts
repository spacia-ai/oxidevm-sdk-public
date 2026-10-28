export interface BoundedRing<T> {
  readonly values: T[];
  start: number;
  dropped: number;
}

export function createBoundedRing<T>(): BoundedRing<T> {
  return { values: [], start: 0, dropped: 0 };
}

export function appendBoundedRing<T>(
  ring: BoundedRing<T>,
  capacity: number,
  value: T,
): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("bounded ring capacity must be a positive integer");
  }
  if (ring.values.length < capacity) {
    ring.values.push(value);
    return;
  }
  ring.values[ring.start] = value;
  ring.start = (ring.start + 1) % capacity;
  ring.dropped += 1;
}

export function readBoundedRing<T>(ring: BoundedRing<T>): readonly T[] {
  return ring.start === 0
    ? ring.values.slice()
    : [...ring.values.slice(ring.start), ...ring.values.slice(0, ring.start)];
}

export function resetBoundedRing<T>(ring: BoundedRing<T>): void {
  ring.values.length = 0;
  ring.start = 0;
  ring.dropped = 0;
}
