/**
 * Seeded, deterministic input generation for the boundary fuzz tests (plan SL-I12). Every run of a seed produces the
 * same inputs, so a failure names its seed and iteration and reproduces exactly; nothing reads the clock or the
 * platform's random source.
 */
export class Random {
  #state: number;

  constructor(seed: number) { this.#state = seed >>> 0; }

  /** mulberry32: a uniform 32-bit integer. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  /** An integer in [0, bound). */
  below(bound: number): number { return this.next() % bound; }

  chance(probability: number): boolean { return this.next() / 0x1_0000_0000 < probability; }

  pick<T>(items: readonly T[]): T {
    const item = items[this.below(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  bytes(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = this.below(256);
    return bytes;
  }
}

/** A Blob that reports a size it does not hold, so budget checks can be fuzzed without allocating it. */
export class SizedBlob extends Blob {
  readonly #size: number;
  constructor(size: number) { super([]); this.#size = size; }
  override get size(): number { return this.#size; }
}

/**
 * Hostile replacements for one field: wrong types, boundary numbers, oversized and odd strings, prototype keys and
 * structured-cloneable objects a decoder must never trust.
 */
export function hostileValue(random: Random): unknown {
  switch (random.below(20)) {
    case 0: return undefined;
    case 1: return null;
    case 2: return random.pick([0, -1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 53, -(2 ** 31), 65, 66, 512 * 1024 ** 2 + 1]);
    case 3: return random.pick(["", "x".repeat(70_000), "\u0000", "../../etc/passwd", "__proto__", "constructor", "😀".repeat(10), "a".repeat(64), `${"a".repeat(64)}:4`]);
    case 4: return random.chance(0.5);
    case 5: return BigInt(random.pick([0, 1, -1, 2 ** 53]));
    case 6: return [];
    case 7: return Array.from({ length: random.pick([1, 65, 66, 200]) }, () => random.pick(["a", 1, null]));
    case 8: return {};
    case 9: return JSON.parse("{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{}}}") as unknown;
    case 10: return new Blob([random.bytes(random.below(16))]);
    case 11: return new SizedBlob(random.pick([0, 4, 512 * 1024 ** 2, 512 * 1024 ** 2 + 1]));
    case 12: return random.bytes(random.below(32));
    case 13: return new ArrayBuffer(random.below(32));
    case 14: return new Date(0);
    case 15: return new Map([["a", 1]]);
    case 16: return Object.fromEntries(Array.from({ length: random.pick([1, 65, 66]) }, (_, index) => [`k${String(index)}`, index]));
    case 17: return { nested: { deeper: [1, { x: "y" }] } };
    case 18: return Symbol.for("hostile");
    default: return new Error("hostile");
  }
}

/**
 * One mutation of a valid message: a field removed, replaced with a hostile value, or added. Answers a new object;
 * `keys` are the fields the mutation may touch.
 */
export function mutate(random: Random, valid: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...valid };
  const rounds = 1 + random.below(3);
  for (let round = 0; round < rounds; round++) {
    const action = random.below(3), key = random.pick(keys);
    if (action === 0) Reflect.deleteProperty(copy, key);
    else if (action === 1) copy[key] = hostileValue(random);
    // An own property even for "__proto__", as a structured clone of a parsed object delivers it.
    else Object.defineProperty(copy, random.pick(["extra", "__proto__", "constructor", "worker", "module", "url", "port2"]), { value: hostileValue(random), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}
